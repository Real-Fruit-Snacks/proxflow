## ProxFlow {{version}}

A visual map of your Proxmox VE hosts and a drag-and-drop lab builder (Active Directory, Windows Server, Linux, containers, nested ESXi) that works **without internet** — labs are built from the ISOs, boxes and templates already on your Proxmox storage.

### Fixed in {{version}}

**Safety**
- **Destroy lab** checks that each VM still belongs to the lab before deleting it. Proxmox hands freed VMIDs out again, and a VM that has taken over one is now left alone.
- Deleting a snapshot can no longer be turned into deleting the VM: snapshot names are checked before anything reaches Proxmox.
- Requests that change something must be JSON, so a web page on another site can't start, stop or delete anything through your browser.

**Map and connections**
- Tokens with PVEVMAdmin but no Sys.Audit on `/` get a map instead of "rejected the credentials". A 403 now reads as a missing privilege.
- Guests on an offline node no longer slow every refresh, and one missed answer no longer flashes a cluster red and resets the layout.
- ProxFlow trusts the certificates Windows trusts, so internal CAs rolled out by group policy work. IPv6 hosts show their certificate for trusting.
- Force stop stays available while a shutdown hangs. A half-confirmed Stop no longer carries over to the next guest you click.

**Lab builder**
- Windows installs without the VirtIO ISO keep the answer CD until setup has finished, so member servers really join the domain. Box Administrator passwords are set reliably, long ones and ones with quotes included.
- Rocky and Alma boxes wait for their setup status instead of reporting ready early. A box built from an earlier lab can't report "ready" from an old status file.
- Nested ESXi on a VLAN is no longer tagged twice.
- A failed or cancelled box restore no longer leaves an untracked multi-GB VM behind. Restored boxes are only reused on a node that can clone them.
- IP checks and suggestions now see the addresses of cloud-init VMs, of the Proxmox host and of labs that still exist.
- New plan checks: 15-character names for machines that join a domain, whole numbers for CPU, memory, disk and VLAN, privileged containers with nesting, and access to the storages holding backups and ISOs.
- **Lab history** lists earlier deployments, so any lab can be reopened and destroyed, also after ProxFlow restarts. Before, a single failed status check could drop the lab from view.
- The review dialog no longer sticks on an old rejected plan. Backspace only deletes a machine while the canvas has focus. The packages box keeps its commas, and Copy works when ProxFlow is opened over plain http.

**Windows package**
- `ProxFlow-demo.cmd` works from folders with `%` or `^` in their path. The window stays open after a crash.
- `--host <address>` opens and prints the address ProxFlow listens on.
- The demo forgets its earlier labs, since the simulated Proxmox starts empty every time.
- Data files saved with a byte-order mark (Notepad, PowerShell 5) are read. A damaged one is kept aside instead of being overwritten.
- The recommended token roles now cover building labs: PVEDatastoreAdmin on `/storage` and, on Proxmox 8 or later, PVESDNUser.

### Download and run (Windows)

1. Download **`proxflow-windows-x64.zip`** below.
2. Right-click the zip → **Properties** → tick **Unblock** → OK, then extract it anywhere.
3. Double-click **`ProxFlow.cmd`** — your browser opens ProxFlow. Try **`ProxFlow-demo.cmd`** first to explore with a simulated Proxmox.

**Everything is in the zip**: the Node.js {{node}} runtime, the server and the web UI. No installation, no internet, no admin rights. Requires Windows 10 / Server 2016 or newer (x64) and a current browser (Edge, Chrome or Firefox). See `README.txt` inside for connecting to Proxmox, options and notes.

### What's in it

- **Map** — every node, VM, container, bridge and storage on a live canvas, with power actions and snapshots.
- **Connections** — guided setup with a one-click diagnosis of certificate, login, network and permission problems; API token or password; trusted-certificate pinning; several hosts at once.
- **Build** — design a lab on a canvas, review the plan, deploy, and destroy it again. Restores boxes from backups once and clones them afterwards; works with or without cloud-init and the QEMU guest agent.

### Known limits

- Tested against a simulated Proxmox only; please report anything that behaves differently on real hardware.
- Nested ESXi is experimental: if the automatic boot option is missed, the console needs one manual step (explained in the app).
- ProxFlow has no login of its own — use `--host 127.0.0.1` to limit it to the computer it runs on.
