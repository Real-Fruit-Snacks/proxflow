import { readFileSync } from 'node:fs';
import { WINDOWS_EDITIONS, WINDOWS_VERSIONS, type WindowsEditionId, type WindowsVersionId } from '@proxflow/shared';
import { buildIso } from '../../iso/iso9660.js';

const SETUP_TEMPLATE = readFileSync(new URL('./windows-setup.ps1', import.meta.url), 'utf8');

export type WindowsNet = { static: boolean; ip?: string; prefix?: number; gateway?: string; dns: string[] };

export type WindowsSetupConfig = {
  computerName: string;
  adminPassword: string;
  mac: string; // "BC-24-11-AA-BB-CC" (Windows format)
  net: WindowsNet;
  role: 'dc' | 'member' | 'standalone';
  /** ISO installs: install VirtIO tools from the driver CD. */
  installDrivers: boolean;
  /** Boxes: set name / IP / Administrator password inside an existing image. ISO installs do this in autounattend. */
  identity: boolean;
  domain?: string;
  netbios?: string;
  dsrmPassword?: string;
  forwarders?: string[];
  join?: { domain: string; netbios: string; password: string; dcIp: string };
};

export const toWindowsMac = (mac: string) => mac.toUpperCase().replace(/:/g, '-');

const CONFIG_TOKEN = "'__CONFIG__'";

export function windowsSetupScript(cfg: WindowsSetupConfig): string {
  const occurrences = SETUP_TEMPLATE.split(CONFIG_TOKEN).length - 1;
  if (occurrences !== 1) throw new Error(`windows-setup.ps1 must contain ${CONFIG_TOKEN} exactly once (found ${occurrences})`);
  const b64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  // CRLF + BOM-less: PowerShell 5.1 reads ASCII-only scripts fine without a BOM.
  return SETUP_TEMPLATE.replace(CONFIG_TOKEN, `'${b64}'`).replace(/\r?\n/g, '\r\n');
}

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const COMPONENT = (name: string) =>
  `<component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">`;

export type AnswerFileOptions = {
  setup: WindowsSetupConfig;
  version: WindowsVersionId;
  edition: WindowsEditionId;
  productKey?: string;
  /** VirtIO disk + NIC drivers come from the driver CD; without it the VM uses SATA + e1000e (inbox drivers). */
  virtio: boolean;
};

/**
 * autounattend.xml for a BIOS (SeaBIOS) install: no "Press any key to boot from CD" prompt
 * (that only appears in UEFI mode), so the install runs without anyone touching the console.
 */
export function autounattendXml(o: AnswerFileOptions): string {
  const { setup: s } = o;
  const index = WINDOWS_EDITIONS[o.edition].index;
  const dirs = [...new Set([WINDOWS_VERSIONS[o.version].driverDir, '2k22'])];
  let key = 0;
  const driverPaths = o.virtio
    ? ['D', 'E', 'F', 'G', 'H']
        .flatMap((d) => dirs.flatMap((dir) => ['vioscsi', 'NetKVM', 'vioserial', 'Balloon'].map((drv) => `${d}:\\${drv}\\${dir}\\amd64`)))
        .map((p) => `<PathAndCredentials wcm:action="add" wcm:keyValue="${++key}"><Path>${p}</Path></PathAndCredentials>`)
        .join('\n          ')
    : '';

  const tcpip =
    s.net.static && s.net.ip
      ? `${COMPONENT('Microsoft-Windows-TCPIP')}
      <Interfaces><Interface wcm:action="add">
        <Ipv4Settings><DhcpEnabled>false</DhcpEnabled></Ipv4Settings>
        <Identifier>${x(s.mac)}</Identifier>
        <UnicastIpAddresses><IpAddress wcm:action="add" wcm:keyValue="1">${x(s.net.ip)}/${s.net.prefix}</IpAddress></UnicastIpAddresses>
        ${s.net.gateway ? `<Routes><Route wcm:action="add"><Identifier>0</Identifier><Prefix>0.0.0.0/0</Prefix><NextHopAddress>${x(s.net.gateway)}</NextHopAddress></Route></Routes>` : ''}
      </Interface></Interfaces>
    </component>`
      : '';

  const dns = s.net.dns.length
    ? `${COMPONENT('Microsoft-Windows-DNS-Client')}
      <Interfaces><Interface wcm:action="add">
        <Identifier>${x(s.mac)}</Identifier>
        <DNSServerSearchOrder>${s.net.dns.map((d, i) => `<IpAddress wcm:action="add" wcm:keyValue="${i + 1}">${x(d)}</IpAddress>`).join('')}</DNSServerSearchOrder>
      </Interface></Interfaces>
    </component>`
    : '';

  const pw = x(s.adminPassword);
  // FirstLogonCommands: find the answer CD (drive letter unknown) and run the setup script from it.
  const firstLogon =
    'cmd /c for %d in (D E F G H I J K) do if exist %d:\\proxflow-setup.ps1 powershell -NoProfile -ExecutionPolicy Bypass -File %d:\\proxflow-setup.ps1';

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    ${COMPONENT('Microsoft-Windows-International-Core-WinPE')}
      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>
    </component>
    ${driverPaths ? `${COMPONENT('Microsoft-Windows-PnpCustomizationsWinPE')}
      <DriverPaths>
          ${driverPaths}
      </DriverPaths>
    </component>` : ''}
    ${COMPONENT('Microsoft-Windows-Setup')}
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition></CreatePartitions>
          <ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter><Active>true</Active></ModifyPartition></ModifyPartitions>
        </Disk>
        <WillShowUI>OnError</WillShowUI>
      </DiskConfiguration>
      <ImageInstall><OSImage>
        <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${index}</Value></MetaData></InstallFrom>
        <InstallTo><DiskID>0</DiskID><PartitionID>1</PartitionID></InstallTo>
        <WillShowUI>OnError</WillShowUI>
      </OSImage></ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula><FullName>ProxFlow</FullName><Organization>ProxFlow lab</Organization>
        ${o.productKey ? `<ProductKey><Key>${x(o.productKey)}</Key><WillShowUI>OnError</WillShowUI></ProductKey>` : ''}
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    ${COMPONENT('Microsoft-Windows-Shell-Setup')}
      <ComputerName>${x(s.computerName)}</ComputerName>
      <TimeZone>UTC</TimeZone>
    </component>
    ${COMPONENT('Microsoft-Windows-TerminalServices-LocalSessionManager')}<fDenyTSConnections>false</fDenyTSConnections></component>
    ${COMPONENT('Networking-MPSSVC-Svc')}
      <FirewallGroups><FirewallGroup wcm:action="add" wcm:keyValue="RemoteDesktop"><Active>true</Active><Group>Remote Desktop</Group><Profile>all</Profile></FirewallGroup></FirewallGroups>
    </component>
    ${tcpip}
    ${dns}
  </settings>
  <settings pass="oobeSystem">
    ${COMPONENT('Microsoft-Windows-Shell-Setup')}
      <UserAccounts><AdministratorPassword><Value>${pw}</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts>
      <AutoLogon><Enabled>true</Enabled><Username>Administrator</Username><Password><Value>${pw}</Value><PlainText>true</PlainText></Password><LogonCount>3</LogonCount></AutoLogon>
      <OOBE><HideEULAPage>true</HideEULAPage><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add"><Order>1</Order><CommandLine>${x(firstLogon)}</CommandLine><Description>ProxFlow setup</Description></SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

/** The answer CD for ISO installs: autounattend.xml + the setup script + non-secret metadata. */
export function windowsAnswerIso(o: AnswerFileOptions, meta: Record<string, unknown>): Buffer {
  return buildIso(
    [
      { name: 'autounattend.xml', data: autounattendXml(o) },
      { name: 'proxflow-setup.ps1', data: windowsSetupScript(o.setup) },
      { name: 'proxflow.json', data: JSON.stringify(meta, null, 2) },
    ],
    { volumeId: 'PFSETUP', jolietVolumeId: 'PFSETUP' },
  );
}
