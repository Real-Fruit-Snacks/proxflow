// Launchers and the README that ship inside each release package.
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

export function windowsFiles(version) {
  return {
    'ProxFlow.cmd': crlf(`@echo off
rem ProxFlow launcher: runs the bundled Node.js runtime, nothing else is needed.
title ProxFlow
"%~dp0node\\node.exe" "%~dp0app\\proxflow.mjs" %*
if errorlevel 1 (
  echo.
  pause
)
`),
    'ProxFlow-demo.cmd': crlf(`@echo off
rem Starts ProxFlow with a built-in simulated Proxmox (nothing real is touched).
call "%~dp0ProxFlow.cmd" --demo %*
`),
    'README.txt': crlf(readme(version, 'windows')),
  };
}

export function linuxFiles(version) {
  return {
    'proxflow.sh': `#!/bin/sh
# ProxFlow launcher: runs the bundled Node.js runtime, nothing else is needed.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$DIR/node/bin/node" "$DIR/app/proxflow.mjs" "$@"
`,
    'README.txt': readme(version, 'linux'),
  };
}

function readme(version, os) {
  const win = os === 'windows';
  const run = win ? 'ProxFlow.cmd' : './proxflow.sh';
  const data = win ? 'data\\' : 'data/';
  return `ProxFlow ${version} - Proxmox map and lab builder
${'='.repeat(48)}

Everything is included, the Node.js runtime too: no installation and no internet needed.


START
-----
${
  win
    ? `Double-click ProxFlow.cmd. Your browser opens ProxFlow. Keep the black window open while you
use it; close it (or press Ctrl+C) to stop.

Things Windows may ask the first time:
- Downloaded the zip from the internet? Right-click it > Properties > tick "Unblock" > OK
  BEFORE extracting, or Windows asks "Do you want to run this file?" every time.
- "Windows protected your PC" (SmartScreen): More info > Run anyway.
- "Windows Defender Firewall has blocked some features": Allow only lets OTHER computers reach
  ProxFlow. You can choose Cancel - ProxFlow still works on this computer.

Any modern browser works: Edge (built into Windows 10/11), Chrome or Firefox. Internet Explorer
does not. On a Windows Server without Edge, open the address from another computer instead.`
    : `Run ./proxflow.sh and open the address it prints in a browser. Press Ctrl+C to stop.`
}

First time? Try the demo: ${win ? 'double-click ProxFlow-demo.cmd' : 'run ./proxflow.sh --demo'}. It uses a built-in simulated
Proxmox with sample ISOs, boxes and templates, so you can design and deploy a whole lab without
touching anything real.


CONNECT TO YOUR PROXMOX
-----------------------
1. In Proxmox: Datacenter > Permissions > API Tokens > Add (e.g. root@pam!proxflow).
   Untick "Privilege Separation", or give the token the PVEVMAdmin role on "/".
   PVEAuditor is enough if you only want the map.
2. In ProxFlow: the connection button (top right) > Add connection.
   Type the host (e.g. 192.168.1.10), the token ID and secret, then "Test connection".
3. Proxmox uses a self-signed certificate: compare the fingerprint ProxFlow shows with
   Proxmox > node > System > Certificates, then "Trust this certificate".
4. Save & connect.


BUILDING LABS
-------------
Switch to "Build". Labs are built only from what is already on your Proxmox storage:
installer ISOs, boxes (backups and templates on your shares), disk images and container
templates. Drag machines in, draw a line from a server to a domain controller to join its
domain, then Review & deploy. "Destroy lab" removes exactly what a deployment created.


OPTIONS
-------
  ${run} --port 8080        use another port (default 3001, or the next free one)
  ${run} --host 127.0.0.1   only allow this computer to open ProxFlow
  ${run} --data-dir <path>  keep your data somewhere else
  ${run} --demo             simulated Proxmox
  ${run} --no-open          don't open a browser
  ${run} --help             all options


YOUR DATA
---------
${data} (next to this file) holds your saved connections - including API token secrets, so keep
this folder private - and your lab history. To upgrade, extract the new version and copy the
${data} folder into it. If this folder isn't writable (e.g. under ${win ? 'C:\\Program Files' : '/opt without root'}),
ProxFlow keeps its data in ${win ? '%LOCALAPPDATA%\\ProxFlow\\data' : '~/.local/share/ProxFlow/data'} instead - the start window shows where.


SECURITY NOTE
-------------
ProxFlow has no login of its own and listens on all network interfaces, so anyone who can reach
this port can use your saved Proxmox connections. Start it with --host 127.0.0.1 to allow only
this computer, or block the port in your firewall.
${
  win
    ? ''
    : `

RUN AS A SERVICE (optional)
---------------------------
Extract to /opt/proxflow, then create /etc/systemd/system/proxflow.service:

  [Unit]
  Description=ProxFlow
  After=network-online.target

  [Service]
  ExecStart=/opt/proxflow/proxflow.sh --no-open
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target

and run: systemctl enable --now proxflow
`
}

REQUIREMENTS
------------
${
  win
    ? `Windows 10 / Windows Server 2016 or newer, 64-bit (x64). Nothing else: the Node.js runtime is in
the node folder and needs only DLLs that are part of Windows - no Visual C++ redistributable, no
.NET, no PowerShell modules, no admin rights.`
    : 'Linux x86-64 with glibc 2.28 or newer (RHEL/Rocky/Alma 8+, Debian 10+, Ubuntu 20.04+).'
}
ProxFlow must reach Proxmox on port 8006, and - to confirm that lab machines without a guest
agent are up - the lab machines' IP addresses.

Third-party licenses: THIRD-PARTY-NOTICES.txt and node/LICENSE.
`;
}
