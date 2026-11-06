## ProxFlow {{version}}

A visual map of your Proxmox VE hosts and a drag-and-drop lab builder (Active Directory, Windows Server, Linux, containers, nested ESXi) that works **without internet** — labs are built from the ISOs, boxes and templates already on your Proxmox storage.

### New in {{version}}

**Offline developer kit.** `proxflow-dev-windows-x64.zip` is for changing ProxFlow on a computer with no internet. It holds:
- the source code;
- Node.js {{node}} and pnpm;
- every package the project uses, in a pnpm store.

Extract it, run `setup.cmd` once (under a minute, nothing downloaded), then open `dev-shell.cmd`. From there `pnpm dev`, the test suites and `pnpm release` all work offline. The release workflow tests the kit the same way before publishing it: no Node.js, pnpm or package registry on the machine.

The simulated Proxmox now makes its HTTPS certificate with Node.js alone, so openssl is no longer needed.

The app itself is unchanged from 0.1.1, which fixed Destroy and snapshot safety, maps for VM-admin tokens and Windows and Rocky readiness, and added lab history — see the [0.1.1 notes](https://github.com/Real-Fruit-Snacks/proxflow/releases/tag/v0.1.1).

### Download and run (Windows)

1. Download **`proxflow-windows-x64.zip`** below.
2. Right-click the zip → **Properties** → tick **Unblock** → OK, then extract it anywhere.
3. Double-click **`ProxFlow.cmd`** — your browser opens ProxFlow. Try **`ProxFlow-demo.cmd`** first to explore with a simulated Proxmox.

To develop ProxFlow offline, download **`proxflow-dev-windows-x64.zip`** instead; its `README.txt` explains the setup.

**Everything is in the zip**: the Node.js {{node}} runtime, the server and the web UI. No installation, no internet, no admin rights. Requires Windows 10 / Server 2016 or newer (x64) and a current browser (Edge, Chrome or Firefox). See `README.txt` inside for connecting to Proxmox, options and notes.

### What's in it

- **Map** — every node, VM, container, bridge and storage on a live canvas, with power actions and snapshots.
- **Connections** — guided setup with a one-click diagnosis of certificate, login, network and permission problems; API token or password; trusted-certificate pinning; several hosts at once.
- **Build** — design a lab on a canvas, review the plan, deploy, and destroy it again. Restores boxes from backups once and clones them afterwards; works with or without cloud-init and the QEMU guest agent.

### Known limits

- Tested against a simulated Proxmox only; please report anything that behaves differently on real hardware.
- Nested ESXi is experimental: if the automatic boot option is missed, the console needs one manual step (explained in the app).
- ProxFlow has no login of its own — use `--host 127.0.0.1` to limit it to the computer it runs on.
