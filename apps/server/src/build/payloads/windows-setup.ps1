# ProxFlow in-guest Windows setup (PowerShell 5.1+). Used two ways:
#  - ISO installs: autounattend.xml runs it at first logon from the answer CD.
#  - Boxes (template/backup): ProxFlow writes it through the QEMU guest agent and runs it as SYSTEM.
#
# Resumable state machine: a step that needs a reboot records the next step in state.txt and a
# startup scheduled task re-runs this script until it reaches "ready". Progress is written to
# C:\ProxFlow\status.txt, which ProxFlow reads through the guest agent when one is present.
# ProxFlow substitutes the config placeholder below with base64 JSON. It contains passwords, so the
# script deletes itself when done.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pf = 'C:\ProxFlow'
New-Item -ItemType Directory -Force -Path $pf | Out-Null
Start-Transcript -Path "$pf\setup.log" -Append | Out-Null
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CONFIG__')) | ConvertFrom-Json
$stateFile = "$pf\state.txt"
$self = "$pf\setup.ps1"
if ($PSCommandPath -and ($PSCommandPath -ne $self)) { Copy-Item -Force $PSCommandPath $self }

function Set-Stage([string]$Stage, [string]$Detail = '') {
  # instance= tells ProxFlow this status is from this deployment, not left in a box built from an earlier lab.
  $text = "stage=$Stage`r`ndetail=$Detail`r`ninstance=$($cfg.instance)`r`nupdated=$((Get-Date).ToUniversalTime().ToString('o'))`r`n"
  [IO.File]::WriteAllText("$pf\status.txt", $text, [Text.Encoding]::ASCII)
  # Write-Host, not Write-Output: output would leak into the steps' $true/$false "needs reboot" return values.
  Write-Host "[$Stage] $Detail"
}

function Register-Resume {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$self`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName 'ProxFlowSetup' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
}

# RDP is switched on at the end of setup (and for boxes, with the identity step): without a guest agent,
# ProxFlow takes "RDP answers" to mean setup has finished, so the answer CD isn't ejected while still needed.
function Enable-Rdp {
  Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
  Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
}

function Find-OnCd([string]$Relative) {
  Get-PSDrive -PSProvider FileSystem | ForEach-Object { Join-Path $_.Root $Relative } | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Wait-Until([scriptblock]$Test, [int]$Minutes, [string]$What) {
  $deadline = (Get-Date).AddMinutes($Minutes)
  while (-not (& $Test)) {
    if ((Get-Date) -gt $deadline) { throw "Timed out after $Minutes min waiting for $What" }
    Start-Sleep -Seconds 15
  }
}

# ── steps: each returns $true when it needs a reboot before the next one ──

function Step-Drivers {
  if (-not $cfg.installDrivers) { return $false }
  Set-Stage 'drivers' 'Installing VirtIO drivers and the QEMU guest agent'
  $tools = Find-OnCd 'virtio-win-guest-tools.exe'
  if ($tools) {
    Start-Process -FilePath $tools -ArgumentList '/install', '/quiet', '/norestart' -Wait
  } else {
    $msi = Find-OnCd 'guest-agent\qemu-ga-x86_64.msi'
    if ($msi) { Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait }
  }
  Start-Service QEMU-GA -ErrorAction SilentlyContinue
  return $false
}

function Step-Identity {
  if (-not $cfg.identity) { return $false }
  Set-Stage 'identity' "Setting name $($cfg.computerName), network and Administrator password"
  # The built-in Administrator (RID 500, whatever it is called in this language). Set through ADSI, not
  # "net user": that mangles quotes under PowerShell 5.1 and stops to ask about passwords over 14 characters.
  $adminName = (Get-CimInstance Win32_UserAccount -Filter 'LocalAccount=True' | Where-Object { $_.SID -match '-500$' } | Select-Object -First 1).Name
  if (-not $adminName) { $adminName = 'Administrator' }
  $admin = [ADSI]"WinNT://$env:COMPUTERNAME/$adminName,user"
  $admin.SetPassword([string]$cfg.adminPassword)
  net user $adminName /active:yes | Out-Null
  $ad = Get-NetAdapter | Where-Object { $_.MacAddress -eq $cfg.mac } | Select-Object -First 1
  if (-not $ad) { $ad = Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1 }
  if ($ad -and $cfg.net.static) {
    Set-NetIPInterface -InterfaceIndex $ad.ifIndex -Dhcp Disabled
    Get-NetIPAddress -InterfaceIndex $ad.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
    Get-NetRoute -InterfaceIndex $ad.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
    $p = @{ InterfaceIndex = $ad.ifIndex; IPAddress = $cfg.net.ip; PrefixLength = [int]$cfg.net.prefix }
    if ($cfg.net.gateway) { $p.DefaultGateway = $cfg.net.gateway }
    New-NetIPAddress @p | Out-Null
  }
  if ($ad -and @($cfg.net.dns).Count -gt 0) { Set-DnsClientServerAddress -InterfaceIndex $ad.ifIndex -ServerAddresses @($cfg.net.dns) }
  # A cloned box may have been given a bigger disk; Windows doesn't grow C: on its own.
  try {
    $max = (Get-PartitionSupportedSize -DriveLetter C).SizeMax
    if ($max -gt (Get-Partition -DriveLetter C).Size + 1MB) { Resize-Partition -DriveLetter C -Size $max }
  } catch { Write-Host "Couldn't extend C: $_" }
  Enable-Rdp
  if ($env:COMPUTERNAME -ne $cfg.computerName) {
    Rename-Computer -NewName $cfg.computerName -Force
    return $true
  }
  return $false
}

function Step-Role {
  switch ($cfg.role) {
    'dc' {
      Set-Stage 'installing-adds' 'Installing the AD DS role'
      Install-WindowsFeature -Name AD-Domain-Services, DNS -IncludeManagementTools | Out-Null
      Set-Stage 'promoting' "Creating forest $($cfg.domain) - the VM reboots"
      Import-Module ADDSDeployment
      $dsrm = ConvertTo-SecureString $cfg.dsrmPassword -AsPlainText -Force
      $r = Install-ADDSForest -DomainName $cfg.domain -DomainNetbiosName $cfg.netbios -SafeModeAdministratorPassword $dsrm -InstallDns -Force -NoRebootOnCompletion
      if ($r -and $r.Status -and "$($r.Status)" -ne 'Success') { throw "AD DS promotion failed: $($r.Message)" }
      return $true
    }
    'member' {
      $j = $cfg.join
      Set-Stage 'waiting-for-domain' "Waiting for $($j.domain) (DNS $($j.dcIp))"
      Wait-Until { Resolve-DnsName -Name "_ldap._tcp.dc._msdcs.$($j.domain)" -Type SRV -Server $j.dcIp -ErrorAction SilentlyContinue } 180 $j.domain
      Set-Stage 'joining' "Joining $($j.domain)"
      $cred = New-Object System.Management.Automation.PSCredential ("$($j.netbios)\Administrator", (ConvertTo-SecureString $j.password -AsPlainText -Force))
      $last = $null
      for ($n = 0; $n -lt 20; $n++) {
        try { Add-Computer -DomainName $j.domain -Credential $cred -Force -ErrorAction Stop; return $true }
        catch { $last = $_; Start-Sleep -Seconds 30 }
      }
      throw "Couldn't join $($j.domain): $last"
    }
    default { return $false }
  }
}

function Step-Verify {
  switch ($cfg.role) {
    'dc' {
      Set-Stage 'starting-ad' 'Waiting for Active Directory services'
      Wait-Until { try { Import-Module ActiveDirectory; [bool](Get-ADDomain -ErrorAction Stop) } catch { $false } } 45 'Active Directory'
      foreach ($f in @($cfg.forwarders)) { if ($f) { try { Add-DnsServerForwarder -IPAddress $f -ErrorAction Stop } catch {} } }
    }
    'member' {
      if (-not (Get-CimInstance Win32_ComputerSystem).PartOfDomain) { throw 'Not part of the domain after reboot' }
    }
  }
  return $false
}

function Step-Cleanup {
  Unregister-ScheduledTask -TaskName 'ProxFlowSetup' -Confirm:$false -ErrorAction SilentlyContinue
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value '0' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $wl -Name DefaultPassword -ErrorAction SilentlyContinue
  Remove-Item -Force -ErrorAction SilentlyContinue 'C:\Windows\Panther\unattend.xml', 'C:\Windows\Panther\Unattend\unattend.xml', 'C:\Windows\Temp\proxflow-setup.ps1', $stateFile, $self
  $done = switch ($cfg.role) { 'dc' { "Domain $($cfg.domain) is up" } 'member' { "Joined $($cfg.join.domain)" } default { 'Windows is ready' } }
  Enable-Rdp
  Set-Stage 'ready' $done
  return $false
}

$steps = 'drivers', 'identity', 'role', 'verify', 'cleanup'
$start = if (Test-Path $stateFile) { (Get-Content $stateFile -Raw).Trim() } else { 'drivers' }
$i = [Math]::Max(0, [Array]::IndexOf($steps, $start))
try {
  Register-Resume
  for (; $i -lt $steps.Count; $i++) {
    $reboot = & "Step-$($steps[$i])"
    if ($reboot -eq $true) {
      Set-Content -Path $stateFile -Value $steps[$i + 1] -Encoding ASCII
      Stop-Transcript | Out-Null
      Restart-Computer -Force
      exit 0
    }
  }
} catch {
  Set-Stage 'failed' ((($_ | Out-String).Trim()) -replace '\s+', ' ')
  Unregister-ScheduledTask -TaskName 'ProxFlowSetup' -Confirm:$false -ErrorAction SilentlyContinue
  try { Enable-Rdp } catch {} # so the machine can still be looked at
}
Stop-Transcript | Out-Null
