// Launchers and the README that ship inside each release package.
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// --use-system-ca: trust what Windows trusts (e.g. an internal CA rolled out by group policy), not only
// Node's built-in list. The pause keeps the window open after any failure, crash codes included.
const launcher = (what, title, extra) => `@echo off
rem ${what}
title ${title}
"%~dp0node\\node.exe" --use-system-ca "%~dp0app\\proxflow.mjs"${extra} %*
if not "%errorlevel%"=="0" (
  echo.
  pause
)
`;

export function windowsFiles(version) {
  return {
    'ProxFlow.cmd': crlf(launcher('ProxFlow launcher: runs the bundled Node.js runtime, nothing else is needed.', 'ProxFlow', '')),
    // Not "call ProxFlow.cmd": call expands % and ^ in the folder path a second time.
    'ProxFlow-demo.cmd': crlf(launcher('Starts ProxFlow with a built-in simulated Proxmox (nothing real is touched).', 'ProxFlow demo', ' --demo')),
    'README.txt': crlf(readme(version, 'windows')),
  };
}

export function linuxFiles(version) {
  return {
    'proxflow.sh': `#!/bin/sh
# ProxFlow launcher: runs the bundled Node.js runtime, nothing else is needed.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$DIR/node/bin/node" --use-system-ca "$DIR/app/proxflow.mjs" "$@"
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

Any current browser works: Edge (built into Windows 10/11), Chrome or Firefox. Internet Explorer
does not. On a Windows Server without Edge, open the address from another computer instead.`
    : `Run ./proxflow.sh and open the address it prints in a browser. Press Ctrl+C to stop.`
}

First time? Try the demo: ${win ? 'double-click ProxFlow-demo.cmd' : 'run ./proxflow.sh --demo'}. It uses a built-in simulated
Proxmox with sample ISOs, boxes and templates, so you can design and deploy a whole lab without
touching anything real.


CONNECT TO YOUR PROXMOX
-----------------------
1. In Proxmox: Datacenter > Permissions > API Tokens > Add (e.g. root@pam!proxflow).
   Untick "Privilege Separation" so the token has its user's rights. A token with rights of
   its own needs, under Datacenter > Permissions > Add:
     PVEAuditor on "/"                          the map: nodes, bridges, storage
     PVEVMAdmin on "/"                          power, snapshots and building labs
     PVEDatastoreAdmin on "/storage"            lab disks, setup CDs and restoring boxes
     PVESDNUser on "/sdn/zones/localnetwork"    attaching lab machines to bridges (Proxmox 8+)
   PVEAuditor alone is enough if you only want the map.
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


// ───────────────────────── offline developer kit ─────────────────────────
// Written with String.raw so the Windows paths keep their backslashes. Batch notes: %~dp0 is expanded once,
// so folders with % ^ & ( in their names are safe inside quotes; "call other.cmd" would expand them a second
// time, so each file stands alone.
export function devKitFiles(version, nodeVersion, pnpmVersion) {
  return {
    'setup.cmd': crlf(String.raw`@echo off
rem One-time setup of the ProxFlow developer kit: unpacks the package store and installs it into source\, offline.
title ProxFlow developer kit setup
"%~dp0node\node.exe" "%~dp0source\scripts\dev-kit-setup.mjs" %*
if not "%errorlevel%"=="0" (
  echo.
  echo Setup did not finish - see the messages above.
  pause
  exit /b 1
)
echo.
echo Next: double-click dev-shell.cmd
pause
`),
    'dev-shell.cmd': crlf(String.raw`@echo off
rem A Command Prompt for working on ProxFlow, with this kit's Node.js and pnpm first on PATH.
title ProxFlow dev shell
set "PATH=%~dp0node;%PATH%"
cd /d "%~dp0source"
if not exist "node_modules\" (
  echo The packages aren't installed yet: run setup.cmd first.
  pause
  exit /b 1
)
echo ProxFlow ${version} dev shell - Node.js ${nodeVersion} and pnpm ${pnpmVersion} from this kit.
echo.
echo   pnpm dev           simulated Proxmox + API + web UI, open http://localhost:5180
echo   pnpm typecheck     type-check every package
echo   pnpm smoke         connection checks, while pnpm dev runs in another dev shell
echo   pnpm smoke:build   lab-builder checks, while pnpm dev runs in another dev shell
echo   pnpm release       build release\proxflow-windows-x64.zip
echo.
cmd /k
`),
    'node/pnpm.cmd': crlf(String.raw`@"%~dp0node.exe" "%~dp0..\pnpm\bin\pnpm.cjs" %*` + '\n'),
    'node/pnpx.cmd': crlf(String.raw`@"%~dp0node.exe" "%~dp0..\pnpm\bin\pnpx.cjs" %*` + '\n'),
    // For Git Bash and other sh-style shells on Windows.
    'node/pnpm': String.raw`#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
exec "$basedir/node.exe" "$basedir/../pnpm/bin/pnpm.cjs" "$@"
`,
    'README.txt': crlf(devKitReadme(version, nodeVersion, pnpmVersion)),
  };
}

function devKitReadme(version, nodeVersion, pnpmVersion) {
  return String.raw`ProxFlow ${version} - offline developer kit
${'='.repeat(42)}

Everything needed to change, test and build ProxFlow on a Windows computer with no internet:
the source code, Node.js ${nodeVersion}, pnpm ${pnpmVersion} and every package the project uses.
No installation and no admin rights. (To only use ProxFlow, get proxflow-windows-x64.zip instead.)


SET UP (once)
-------------
1. Downloaded the zip from the internet? Right-click it > Properties > tick "Unblock" > OK
   BEFORE extracting.
2. Extract it to a short path such as C:\dev - some packages have long file names.
3. Double-click setup.cmd. It unpacks the packages into store\ and installs them into
   source\ (a minute or two, no network used), then makes the simulated Proxmox's certificate.

Moved or copied the kit folder? Run setup.cmd again: it redoes the links the move broke.


WORK ON IT
----------
Double-click dev-shell.cmd: a Command Prompt in source\ with this kit's Node.js and pnpm on
PATH. Type "powershell" in it if you prefer PowerShell; an editor started from it (for
example "code .") gets the same tools.

  pnpm dev           simulated Proxmox (:8006 http, :8007 https) + API (:3001) + web UI
                     on http://localhost:5180 - changes reload as you save
  pnpm dev:real      the same without the simulator, to connect to a real Proxmox
  pnpm typecheck     type-check every package
  pnpm smoke         connection checks       } while pnpm dev runs
  pnpm smoke:build   lab-builder checks      } in a second dev shell
  pnpm release       build release\proxflow-windows-x64.zip, the same package that is published

source\docs\DEVELOPMENT.md explains how the code fits together.


ADDING OR UPGRADING PACKAGES
----------------------------
Offline, pnpm can only install what is already in store\, which is exactly what
source\pnpm-lock.yaml lists. To add or upgrade a package, copy the whole kit to a computer
with internet and run this in its dev shell:

  pnpm add <package> --config.offline=false

The new package lands in store\. Copy the kit folder back and run setup.cmd once.


WHAT IS WHERE
-------------
  source\        the ProxFlow repository (no git history - run "git init" there if you use git)
  node\          Node.js ${nodeVersion} (node.exe), plus pnpm.cmd and pnpx.cmd
  pnpm\          pnpm ${pnpmVersion}
  store.tar.gz   every package, packed; setup.cmd unpacks it into store\
  source\.npmrc  written by setup.cmd: points pnpm at store\ and keeps it offline

Licenses: source\LICENSE (ProxFlow, MIT), node\LICENSE (Node.js) and THIRD-PARTY-NOTICES.txt
(pnpm and every package in the store; each package also keeps its own license file).
`;
}
