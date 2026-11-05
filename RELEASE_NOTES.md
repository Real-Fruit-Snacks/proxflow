## ProxFlow {{version}}

A visual map of your Proxmox VE hosts and a drag-and-drop lab builder (Active Directory, Windows Server, Linux, containers, nested ESXi) that works **without internet** — labs are built from the ISOs, boxes and templates already on your Proxmox storage.

### Download and run (Windows)

1. Download **`proxflow-{{version}}-windows-x64.zip`** below.
2. Right-click the zip → **Properties** → tick **Unblock** → OK, then extract it anywhere.
3. Double-click **`ProxFlow.cmd`** — your browser opens ProxFlow. Try **`ProxFlow-demo.cmd`** first to explore with a simulated Proxmox.

**Everything is in the zip**: the Node.js {{node}} runtime, the server and the web UI. No installation, no internet, no admin rights. Requires Windows 10 / Server 2016 or newer (x64) and a modern browser (Edge, Chrome or Firefox). See `README.txt` inside for connecting to Proxmox, options and notes.

### What's in it

- **Map** — every node, VM, container, bridge and storage on a live canvas, with power actions and snapshots.
- **Connections** — guided setup with a one-click diagnosis of certificate, login, network and permission problems; API token or password; trusted-certificate pinning; several hosts at once.
- **Build** — design a lab on a canvas, review the plan, deploy, and destroy it again. Restores boxes from backups once and clones them afterwards; works with or without cloud-init and the QEMU guest agent.

### Known limits

- Tested against a simulated Proxmox only; please report anything that behaves differently on real hardware.
- Nested ESXi is experimental: if the automatic boot option is missed, the console needs one manual step (explained in the app).
- ProxFlow has no login of its own — use `--host 127.0.0.1` to limit it to the computer it runs on.
