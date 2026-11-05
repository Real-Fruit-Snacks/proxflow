/**
 * Turns a LabSpec + what's on the target into an executable plan: validation and permission
 * issues, VMIDs/MACs, assets, and a dependency graph of steps. Nothing here talks to Proxmox —
 * steps do that when the deployment runs.
 */
import { kindLabel, validateLab, versionAtLeast, type LabIssue, type LabPlan, type LabSpec, type MachineSpec, type PlannedMachine } from '@proxflow/shared';
import type { RawPermissions } from '../pve/types.js';
import type { BoxCache } from './box-cache.js';
import type { InventoryBundle } from './inventory.js';
import { labSlug, newMac, type PlanCtx } from './plan-common.js';
import { planLinuxVm } from './plan-linux.js';
import { planEsxi, planLxc } from './plan-other.js';
import { planWindows } from './plan-windows.js';
import type { StepDef } from './steps.js';

/** Privilege granted on `path` or inherited from an ancestor ACL path. */
function granted(perms: RawPermissions, priv: string, path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    if (perms[`/${parts.slice(0, i).join('/')}`]?.[priv]) return true;
  }
  return false;
}

function privilegeIssues(spec: LabSpec, bundle: InventoryBundle): LabIssue[] {
  const perms = bundle.perms;
  if (!perms) return [{ level: 'warning', message: 'Couldn\'t read this connection\'s permissions — problems will show up as deploy errors instead.' }];
  const out: LabIssue[] = [];
  const missing = (privs: string[], path: string) => privs.filter((p) => !granted(perms, p, path));
  const T = spec.target;
  const ms = spec.machines;
  const anyQemu = ms.some((m) => m.kind !== 'lxc');
  const fromBoxes = ms.some((m) => 'source' in m && (m.source.type === 'template' || m.source.type === 'backup'));
  const uploads = ms.some((m) => m.kind === 'linux-vm' || m.kind === 'esxi' || (m.kind === 'windows' && m.source.type === 'iso'));
  const downloads = ms.some((m) => m.kind === 'linux-vm' && m.source.type === 'catalog');

  const vm = missing(
    ['VM.Allocate', 'VM.Config.Disk', 'VM.Config.CDROM', 'VM.Config.CPU', 'VM.Config.Memory', 'VM.Config.Network', 'VM.Config.HWType', 'VM.Config.Options', 'VM.PowerMgmt', ...(fromBoxes ? ['VM.Clone'] : [])],
    '/vms',
  );
  if (vm.length) out.push({ level: 'error', message: `The API token is missing ${vm.join(', ')} on /vms — give it the PVEVMAdmin role on "/".` });
  const disk = missing(['Datastore.AllocateSpace'], `/storage/${T.diskStorage}`);
  if (disk.length) out.push({ level: 'error', message: `The API token can't allocate disks on ${T.diskStorage} (needs Datastore.AllocateSpace).` });
  if (uploads && missing(['Datastore.AllocateTemplate'], `/storage/${T.isoStorage}`).length)
    out.push({ level: 'error', message: `The API token can't upload setup ISOs to ${T.isoStorage} (needs Datastore.AllocateTemplate).` });
  if (downloads && missing(['Datastore.AllocateTemplate'], `/storage/${T.importStorage}`).length)
    out.push({ level: 'error', message: `The API token can't download images to ${T.importStorage} (needs Datastore.AllocateTemplate).` });
  if (downloads && missing(['Sys.AccessNetwork'], `/nodes/${T.node}`).length && versionAtLeast(bundle.inv.version, '8.1'))
    out.push({ level: 'warning', message: 'Downloads may need Sys.AccessNetwork on the node.' });
  if (versionAtLeast(bundle.inv.version, '8.0')) {
    for (const b of new Set(ms.map((m) => m.net.bridge || T.bridge))) {
      if (missing(['SDN.Use'], `/sdn/zones/localnetwork/${b}`).length)
        out.push({ level: 'warning', message: `Attaching VMs to ${b} may need SDN.Use on /sdn/zones/localnetwork/${b} (role PVESDNUser).` });
    }
  }
  if (anyQemu && missing(['VM.Monitor'], '/vms').length && missing(['VM.GuestAgent.Audit'], '/vms').length)
    out.push({ level: 'warning', message: 'The token can\'t use the guest agent (VM.Monitor on Proxmox 8, VM.GuestAgent.* on 9) — ProxFlow will fall back to port checks and can\'t configure boxes.' });
  if (ms.some((m) => m.kind === 'esxi') && missing(['VM.Console'], '/vms').length)
    out.push({ level: 'warning', message: 'Without VM.Console ProxFlow can\'t type the ESXi boot option — you\'ll do it in the console.' });
  return out;
}

const MINUTES: Record<string, number> = { 'linux-vm': 4, lxc: 1, 'windows-iso': 30, 'windows-box': 10, esxi: 15 };

function estimate(spec: LabSpec, restores: number, downloads: number): number {
  let longest = 0;
  for (const m of spec.machines) {
    let t = MINUTES[m.kind === 'windows' ? (m.source.type === 'iso' ? 'windows-iso' : 'windows-box') : m.kind] ?? 5;
    if (m.kind === 'windows' && m.role === 'dc') t += 10;
    longest = Math.max(longest, t);
  }
  return Math.max(1, Math.round(longest + restores * 10 + downloads * 10));
}

const dispatch = (pc: PlanCtx, m: MachineSpec, vmid: number, mac: string): PlannedMachine => {
  switch (m.kind) {
    case 'linux-vm':
      return planLinuxVm(pc, m, vmid, mac);
    case 'windows':
      return planWindows(pc, m, vmid, mac);
    case 'esxi':
      return planEsxi(pc, m, vmid, mac);
    case 'lxc':
      return planLxc(pc, m, vmid, mac);
  }
};

export function planLab(spec: LabSpec, bundle: InventoryBundle, opts: { tag: string; boxCache: BoxCache }): { plan: LabPlan; steps: StepDef[] } {
  const inv = bundle.inv;
  const issues: LabIssue[] = [...validateLab(spec, inv), ...privilegeIssues(spec, bundle)];

  const used = new Set(inv.usedVmids);
  let next = Math.max(100, inv.nextId || 100);
  const allocVmid = () => {
    while (used.has(next)) next++;
    used.add(next);
    return next++;
  };

  const pc: PlanCtx = {
    spec,
    inv,
    T: spec.target,
    node: spec.target.node,
    conn: spec.target.conn,
    tag: opts.tag,
    labTag: `pf-${labSlug(spec.name)}`,
    description: `Created by ProxFlow — lab "${spec.name}" (deployment ${opts.tag})`,
    steps: [],
    assets: [],
    issues,
    boxCache: opts.boxCache,
    boxes: new Map(),
    allocVmid,
  };

  // Machines get VMIDs first (in lab order), then any box templates that need restoring.
  const ids = spec.machines.map((m) => ({ m, vmid: allocVmid(), mac: newMac() }));
  const machines: PlannedMachine[] = [];
  const valid = !issues.some((i) => i.level === 'error');
  for (const { m, vmid, mac } of ids) {
    if (valid) {
      try {
        machines.push(dispatch(pc, m, vmid, mac));
        continue;
      } catch (e) {
        issues.push({ level: 'error', machine: m.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    machines.push({ id: m.id, name: m.name, kind: m.kind, label: kindLabel(m), vmid, type: m.kind === 'lxc' ? 'lxc' : 'qemu', mac, summary: '', access: [], readiness: '' });
  }

  const ok = !issues.some((i) => i.level === 'error');
  const restores = pc.steps.filter((s) => s.group === 'restore').length;
  const downloads = pc.steps.filter((s) => s.group === 'download').length;
  const steps = ok ? pc.steps : [];
  return {
    plan: {
      ok,
      issues,
      machines,
      assets: pc.assets,
      steps: steps.map((s) => ({ id: s.id, machine: s.machine, title: s.title, deps: s.deps })),
      estimateMinutes: estimate(spec, restores, downloads),
      mock: inv.mock,
    },
    steps,
  };
}
