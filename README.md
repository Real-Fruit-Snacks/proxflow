# ProxFlow

A [React Flow](https://reactflow.dev)-style canvas for Proxmox VE:

- **Map** — every Proxmox node is a group box containing its VMs and containers, with that node's bridges and
  local storage underneath and shared storage below. Click anything for live metrics and power/snapshot actions.
- **Build** — drag-and-drop lab builder (Active Directory, Windows Server, Linux, containers, nested ESXi) that
  works **offline**, from the ISOs, boxes and templates already on your Proxmox storage.

## Download (Windows)

Get `proxflow-<version>-windows-x64.zip` from [Releases](../../releases). It contains **everything** — the
Node.js runtime, the server and the web UI — so it needs no installation, no internet and no admin rights:
unblock the zip (Properties → Unblock), extract it, double-click `ProxFlow.cmd`. `ProxFlow-demo.cmd` starts it
with a simulated Proxmox to try things out. `README.txt` in the zip covers the rest.

### Building a release

```bash
pnpm release                         # → release/proxflow-<version>-windows-x64.zip + SHA256SUMS.txt
node scripts/release-smoke.mjs       # extract it fresh, start it with no Node.js on PATH, run the lab suite
```

`scripts/release.mjs` builds the UI, bundles the server and all its packages into one file (the build fails if
anything but Node.js built-ins is left outside the bundle, or if the UI references an external URL), adds the
official Node.js runtime (SHA-256 verified) and third-party license notices. `--targets linux-x64` builds a Linux
package too.

To publish: bump `version` in `package.json`, update `RELEASE_NOTES.md`, commit, then
`git tag v<version> && git push --tags`. The [Release workflow](.github/workflows/release.yml) builds and tests
the package on Windows and only publishes it if every test passes.

```
┌──────────────────────────────┐          ┌──────────────────────────┐
│  apps/web  (Vite + React)    │  /api    │  apps/server (Express)   │   /api2/json   ┌───────────────┐
│  @xyflow/react canvas,       │ ───────▶ │  topology builder,       │ ─────────────▶ │  Proxmox VE   │
│  inspector, TanStack Query   │          │  operations, task polls  │                │  or mock-pve  │
└──────────────────────────────┘          └──────────────────────────┘                └───────────────┘
                                                     ▲
                       packages/shared ──────────────┘  (graph + API types used by both sides)
```

`apps/mock-pve` is a fake Proxmox that speaks the real `/api2/json` contract (token + ticket auth, permissions,
cluster resources, node network, guest config, UPID tasks, snapshots, clone). It listens on plain HTTP :8006 and,
after `pnpm --filter @proxflow/mock-pve gen-cert`, on self-signed HTTPS :8007 — just like a fresh Proxmox install.

## Quick start

```bash
pnpm install
pnpm dev          # mock Proxmox :8006/:8007  +  API :3001  +  web :5180 (mock pre-connected)
pnpm dev:real     # same without the mock — opens the "Connect to Proxmox" dialog on first run
```

## Connecting to Proxmox

Click the connection button (top-right) → **Add connection**. No config files, no restart.

1. **Host** — type it however you like: `192.168.1.10`, `pve.lan`, `https://pve.example.com:8006`. Bare hosts get
   `https://` and port `8006`; if an explicit `https://host` without a port doesn't answer, 8006 is tried automatically.
2. **Credentials** — either
   - an **API token** (recommended): *Datacenter → Permissions → API Tokens → Add*, ID like `root@pam!proxflow`; or
   - **username & password** (`root@pam`, `admin@pve` …; the realm defaults to `@pam`). ProxFlow logs in for a
     ticket and renews it automatically. Accounts with two-factor auth need a token instead.
3. **Test connection** — one click tells you exactly what's wrong, or what you connected to:

   | Result | What you see |
   | --- | --- |
   | Self-signed certificate (normal for Proxmox) | Certificate subject, issuer, expiry and **SHA-256 fingerprint** → **Trust this certificate** pins it. Compare with *node → System → Certificates*. |
   | Certificate changed since you trusted it | Old vs new fingerprint warning, re-trust button |
   | Wrong credentials | Token-format / realm / privilege-separation hints |
   | Wrong scheme | `https://` to an HTTP port or `http://` to an HTTPS port, detected and corrected |
   | Port closed / DNS / timeout / no route | Specific message + what to check |
   | Connected | Version, cluster or standalone, nodes (online/offline), and a **permission summary** — e.g. “read-only: start/stop needs VM.PowerMgmt” — before you hit an empty map |

4. **Save & connect.** Save always re-tests first, so a broken connection can't be saved by accident.

Several connections can be active at once: each cluster or standalone host gets its own row on the map, and an
unreachable one shows as a red strip with the reason instead of breaking the rest.

**Security.** Secrets stay on the API server (`apps/server/data/connections.json`, git-ignored) and are never sent
back to the browser — editing a connection with a blank secret keeps the stored one. Pinned TLS checks the exact
certificate on every connection; “connect without verifying” exists but is labelled as not recommended.

**Headless / Docker.** Set `PVE_URL` plus `PVE_TOKEN_ID`/`PVE_TOKEN_SECRET` (or `PVE_USERNAME`/`PVE_PASSWORD`) and
optionally `PVE_FINGERPRINT` — see `.env.example`. Env-defined connections apply for that run only and aren't saved.

**Suggested roles:** `PVEAuditor` on `/` for a read-only map; `PVEVMUser` or `PVEVMAdmin` to power-manage and
snapshot; **`PVEVMAdmin` on `/`** (plus `PVEDatastoreUser` on your storages) to build labs.

## Building labs (Build mode)

Switch to **Build** in the header. Drag machines onto the canvas (or click them, or start from a preset), draw a
line from a server to a domain controller to join its domain, then **Review & deploy**. ProxFlow plans everything
first — permissions, storage, IPs, names, passwords — and only creates VMs when you press Deploy.

**Offline by design.** Labs are built from what's already on Proxmox storage — nothing is downloaded:

| Machine | Built from | How it's configured |
| --- | --- | --- |
| Domain controller / Windows Server | Windows installer ISO (unattended) **or** a Windows box (template / backup) | ISO: answer file on a small generated CD. Box: setup script sent through the QEMU guest agent. Either way it promotes a new forest or joins the lab's domain. |
| Linux VM | Box (vzdump backup), VM template, or disk image (qcow2/raw/vmdk/img) | cloud-init seed CD (hostname, user, password/SSH key, static IP/DNS, optional AD join via realmd) |
| Container | Container template on storage, or a container backup | Proxmox container settings |
| ESXi (experimental) | ESXi installer ISO | Kickstart CD + ProxFlow types `ks=cdrom:/KS.CFG` at the boot menu |

- **Boxes that are backups** (the "Restore → it appears as a template → Clone" routine) are restored **once**, kept
  as a template tagged `pf-box`, and cloned from then on.
- **Templates on another node** are cloned across when their disks are on shared storage.
- **No guest agent in the box?** ProxFlow falls back to checking the machine's static IP (SSH 22, RDP 3389,
  LDAP 389, HTTPS 443). Without an agent *and* without a static IP it can only say "started".
- **No VirtIO ISO on storage?** Windows still installs, using SATA + Intel NIC drivers (no guest agent).
- **No package installs** happen unless you list packages (they need a reachable repo/mirror). Linux AD join needs
  `realmd`, `sssd` and `adcli` already in the image.
- Setup CDs contain passwords; they're ejected and deleted once each machine is ready. **Destroy lab** removes
  exactly the VMs and files a deployment created (box templates are kept for reuse).
- Downloading official cloud images is still possible but opt-in, and only works if the node has internet.

`pnpm smoke:build` deploys a 10-machine offline lab against the mock (AD forest, Windows box joined via the agent,
Rocky box joined via realmd, a no-agent box confirmed over SSH, cross-node template clone, containers, nested ESXi),
then checks box reuse, failure handling and Destroy.

## API (apps/server)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/connections` | Saved connections (secrets redacted) with last status |
| `POST` | `/api/connections/test` | Probe unsaved `{ url, auth, tls? }` → `ProbeResult` |
| `POST` | `/api/connections` | Save a connection |
| `POST` | `/api/connections/:id/test` | Probe a saved one, optionally with edits (blank secret = stored) |
| `PUT` / `DELETE` | `/api/connections/:id` | Update / remove |
| `GET` | `/api/topology` | Merged graph `{ clusters[], nodes[], edges[] }` across enabled connections (cached ~2 s each) |
| `POST` | `/api/guests/:conn/:node/:type/:vmid/:action` | start / stop / shutdown / reboot / suspend / resume → `{ upid }` |
| `GET` | `/api/tasks/:conn/:node/:upid?wait=ms` | Long-polls a Proxmox task |
| `GET` / `POST` | `/api/guests/:conn/:node/:type/:vmid/snapshots` | List / create `{ name, description? }` |
| `DELETE` | `/api/guests/:conn/:node/:type/:vmid/snapshots/:name` | Delete |
| `GET` | `/api/connections/:id/inventory?node=` | What labs can be built from: ISOs, boxes, templates, disk images, storages, bridges |
| `POST` | `/api/labs/plan` | `LabSpec` → `LabPlan` (issues with one-click fixes, VMIDs, readiness, assets) |
| `POST` | `/api/labs/deploy` | Start a deployment (re-plans; 400 with the plan if it has errors) |
| `GET` | `/api/labs/deployments[/:id]` | Progress: per-machine status, steps, log |
| `POST` | `/api/labs/deployments/:id/cancel` · `…/destroy` | Stop a run · delete what it created |

Graph IDs are namespaced by connection: `mock/node:pve1`, `mock/guest:101`, `mock/bridge:pve1/vmbr0`,
`mock/storage:nas-nfs` (shared) / `mock/storage:pve1/local-lvm` (local).

`pnpm smoke` runs 37 end-to-end checks of the connection flow (auth, TLS pinning, error diagnosis, multi-connection)
against the running `pnpm dev` stack.

## Layout of the repo

```
apps/
  web/        Vite + React 19 + @xyflow/react + Tailwind v4 + TanStack Query
    src/layout.ts        group-box layout (positions preserved across refreshes; "Re-layout" resets)
    src/nodes/           custom node components (PveNodeGroup, GuestNode, BridgeNode, StorageNode)
    src/components/      TopBar, Inspector (per-kind panels, actions, snapshots)
    src/api.ts           fetch wrappers, queries, mutations with toast + task polling
  server/     Express 5 + undici
    src/app.ts           startServer(): API (+ the built UI when webDir is set) — used by both entries below
    src/index.ts         dev entry (API only; Vite serves the UI)
    src/release.ts       release entry: CLI, one port for UI + API, --demo runs the mock in-process
    src/pve/client.ts    Proxmox client: token or ticket auth, TLS pinning, host-input normalisation
    src/pve/probe.ts     "Test connection" diagnosis (TLS / auth / network / permissions)
    src/connections/     saved-connection store + per-connection clients and topology caches
    src/pve/topology.ts  raw resources + per-guest config → graph
    src/pve/parse.ts     netN / scsiN / rootfs / mpN config-string parsers
    src/pve/operations.ts discrete, composable actions
    src/build/           lab builder: inventory, planner (plan*.ts), step helpers, deployment runner, box cache
    src/build/payloads/  cloud-init seed, Windows answer file + setup script (.ps1), ESXi kickstart
    src/iso/iso9660.ts   dependency-free ISO 9660 + Joliet writer for the setup CDs
  web/src/build/         Build mode: canvas, palette, machine/lab panels, review dialog, deployment panel
  mock-pve/   fake /api2/json: cluster state, storage + a "share" with ISOs/boxes, create/clone/restore,
              guest agent, sendkey, and simulated in-guest setup (sim.ts) driven by the uploaded setup CDs
packages/
  shared/     graph + API types, lab spec/plan/deployment types, validation shared by UI and server
scripts/
  release.mjs            self-contained release packages (see "Building a release")
  release-smoke.mjs      tests a package the way a user gets it
```

Scripts: `pnpm typecheck` (all packages), `pnpm build` (web), `pnpm smoke` / `pnpm smoke:build` (needs `pnpm dev`),
`pnpm release`.

## Roadmap

- Test against real Proxmox hardware (everything so far is verified against the mock only).
- ESXi: fully unattended install by patching boot.cfg on an uploaded ISO instead of typing the boot option.
- Windows boxes without the guest agent: configure via cloudbase-init when present.
- Hover/selection path highlighting across VLANs; SDN zones/vnets as first-class nodes.
- Persist dragged positions per cluster (localStorage), console/log drawer, bulk actions by tag.
