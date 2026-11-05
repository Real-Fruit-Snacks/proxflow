/** Step factories shared by every machine kind. */
import { randomBytes } from 'node:crypto';
import {
  effectiveBridge,
  type GuestType,
  type InventoryBackup,
  type LabIssue,
  type LabSpec,
  type LabTarget,
  type MachineSpec,
  type PlannedAsset,
  type TargetInventory,
} from '@proxflow/shared';
import type { Params } from '../pve/client.js';
import { parseKv, parseSizeGiB } from '../pve/parse.js';
import type { RawGuestConfig } from '../pve/types.js';
import type { BoxCache } from './box-cache.js';
import { waitForTask, type StepContext, type StepDef } from './steps.js';

export type PlanCtx = {
  spec: LabSpec;
  inv: TargetInventory;
  T: LabTarget;
  node: string;
  conn: string;
  tag: string; // deployment id ("preview" while planning)
  labTag: string; // Proxmox tag on every guest, e.g. "pf-ad-lab"
  description: string;
  steps: StepDef[];
  assets: PlannedAsset[];
  issues: LabIssue[];
  boxCache: BoxCache;
  boxes: Map<string, { stepId?: string; vmid: number; node: string }>;
  allocVmid(): number;
};

export const newMac = () => `BC:24:11:${[...randomBytes(3)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')}`;

export const netString = (model: string, mac: string, bridge: string, vlan?: number) =>
  `${model}=${mac},bridge=${bridge},firewall=1${vlan ? `,tag=${vlan}` : ''}`;

export const guestTags = (pc: PlanCtx) => `proxflow;${pc.labTag}`;

export const labSlug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'lab';

const fmtSize = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MiB`);

// ───── config inspection (for clones of boxes we didn't build) ─────

const NIC_MODELS = new Set(['virtio', 'e1000', 'e1000e', 'vmxnet3', 'rtl8139']);
const DRIVE = /^(ide|sata|scsi|virtio)\d+$/;

export function nicModel(cfg: RawGuestConfig): string {
  const m = /^([a-z0-9-]+)=/.exec(String(cfg.net0 ?? ''));
  return m && NIC_MODELS.has(m[1]!) ? m[1]! : 'virtio';
}

/** Drives holding a Proxmox cloud-init disk — removed so our seed is the only "cidata" source. */
export const cloudInitDrives = (cfg: RawGuestConfig) =>
  Object.entries(cfg)
    .filter(([k, v]) => DRIVE.test(k) && typeof v === 'string' && /cloudinit/.test(v))
    .map(([k]) => k);

export function freeCdromSlot(cfg: RawGuestConfig, avoid: string[]): string {
  for (const s of ['ide2', 'ide3', 'ide0', 'ide1', 'sata5', 'sata4', 'sata3', 'sata2']) if (cfg[s] === undefined && !avoid.includes(s)) return s;
  throw new Error('No free CD-ROM slot (IDE/SATA) for the setup ISO');
}

/** The disk the VM boots from: first disk in boot order, else the first non-CD drive. */
export function bootDisk(cfg: RawGuestConfig): { key: string; sizeGiB?: number } | undefined {
  const isDisk = (k: string) => typeof cfg[k] === 'string' && DRIVE.test(k) && !/media=cdrom/.test(String(cfg[k])) && !/cloudinit/.test(String(cfg[k]));
  const order = /order=([^,]+)/.exec(String(cfg.boot ?? ''))?.[1]?.split(';') ?? [];
  const key = order.find(isDisk) ?? ['scsi0', 'virtio0', 'sata0', 'ide0'].find(isDisk) ?? Object.keys(cfg).find(isDisk);
  if (!key) return undefined;
  return { key, sizeGiB: parseSizeGiB(parseKv(String(cfg[key])).opts.size) };
}

export async function growDisk(ctx: StepContext, type: GuestType, vmid: number, disk: { key: string; sizeGiB?: number } | undefined, wantGiB: number) {
  if (!disk) return 'no disk found to resize';
  if (disk.sizeGiB !== undefined && disk.sizeGiB >= wantGiB) return `disk already ${disk.sizeGiB} GiB`;
  await waitForTask(ctx, await ctx.client.resize(ctx.node, type, vmid, disk.key, `${wantGiB}G`), { what: 'Resize disk' });
  return `disk grown to ${wantGiB} GiB`;
}

// ───── assets ─────

/** Upload one of ProxFlow's small setup ISOs (seed / answer / kickstart) to the ISO storage. */
export function uploadIsoStep(pc: PlanCtx, m: MachineSpec, vmid: number, kind: 'seed' | 'answer' | 'ks', build: () => Buffer) {
  const fileName = `pf-${pc.tag}-${vmid}-${kind}.iso`;
  const volid = `${pc.T.isoStorage}:iso/${fileName}`;
  const title = { seed: 'Upload cloud-init seed', answer: 'Upload Windows answer file', ks: 'Upload ESXi kickstart' }[kind];
  const id = `${m.id}:${kind}`;
  pc.steps.push({
    id,
    machine: m.id,
    title,
    group: 'upload',
    deps: [],
    run: async (ctx) => {
      const data = build();
      const upid = await ctx.client.uploadFile(pc.node, pc.T.isoStorage, 'iso', fileName, data);
      ctx.recordUpload(volid);
      await waitForTask(ctx, upid, { what: 'Upload' });
      return { detail: `${fileName} (${Math.ceil(data.length / 1024)} KiB)` };
    },
  });
  pc.assets.push({ id, label: `${title} for ${m.name}`, volid, action: 'upload', detail: 'Deleted again once the machine is ready (it contains passwords)' });
  return { stepId: id, volid };
}

/**
 * A backup on storage → a template we can clone. Restored once per backup and remembered, so the
 * next lab skips straight to cloning (mirrors the manual Restore → Clone flow in the Proxmox UI).
 */
export function ensureBoxTemplate(pc: PlanCtx, backup: InventoryBackup): { stepId?: string; vmid: number; node: string } {
  const known = pc.boxes.get(backup.volid);
  if (known) return known;
  const cached = pc.boxCache.lookup(pc.conn, backup.volid, pc.inv.vmTemplates);
  if (cached) {
    const ref = { vmid: cached.vmid, node: cached.node };
    pc.boxes.set(backup.volid, ref);
    pc.assets.push({ id: `box:${backup.volid}`, label: `Box ${backup.notes ?? backup.name}`, volid: backup.volid, action: 'reuse', detail: `Already restored as template ${cached.vmid}` });
    return ref;
  }
  const vmid = pc.allocVmid();
  const type = backup.subtype;
  const id = `box:${vmid}`;
  pc.steps.push({
    id,
    title: `Restore box ${backup.notes ?? backup.name}`,
    group: 'restore',
    deps: [],
    run: async (ctx) => {
      ctx.detail(`Restoring ${backup.name} (${fmtSize(backup.size)}) to template ${vmid}`);
      const params: Params =
        type === 'qemu'
          ? { vmid, archive: backup.volid, storage: pc.T.diskStorage, unique: 1 }
          : { vmid, ostemplate: backup.volid, restore: 1, storage: pc.T.diskStorage, unique: 1 };
      await waitForTask(ctx, await ctx.client.createGuest(pc.node, type, params), { what: 'Restore', timeoutMs: 180 * 60_000 });
      const cfg = await ctx.client.guestConfig(pc.node, type, vmid);
      if (String(cfg.template ?? '') !== '1') {
        await waitForTask(ctx, await ctx.client.convertToTemplate(pc.node, type, vmid), { what: 'Convert to template' });
      }
      await ctx.client.updateConfig(pc.node, type, vmid, { description: `Box restored by ProxFlow from ${backup.volid}`, tags: 'proxflow;pf-box' });
      pc.boxCache.remember(pc.conn, backup.volid, vmid, pc.node);
      return { detail: `Kept as template ${vmid} — later labs clone it directly` };
    },
  });
  pc.assets.push({
    id,
    label: `Box ${backup.notes ?? backup.name}`,
    volid: backup.volid,
    action: 'reuse',
    detail: `Restored once to template ${vmid} (${fmtSize(backup.size)}) and kept for future labs`,
  });
  const ref = { stepId: id, vmid, node: pc.node };
  pc.boxes.set(backup.volid, ref);
  return ref;
}

/** Full clone of a template onto the lab's node and disk storage. */
export function cloneStep(
  pc: PlanCtx,
  m: MachineSpec,
  type: GuestType,
  vmid: number,
  src: { vmid: number; node: string; stepId?: string },
): string {
  const id = `${m.id}:clone`;
  pc.steps.push({
    id,
    machine: m.id,
    title: `Clone template ${src.vmid}`,
    group: 'create',
    deps: src.stepId ? [src.stepId] : [],
    run: async (ctx) => {
      const crossNode = src.node !== pc.node;
      const upid = await ctx.client
        .clone(src.node, type, src.vmid, {
          newid: vmid,
          ...(type === 'qemu' ? { name: m.name } : { hostname: m.name }),
          full: true,
          storage: pc.T.diskStorage,
          ...(crossNode ? { target: pc.node } : {}),
        })
        .catch((e: unknown) => {
          if (crossNode) throw new Error(`${e instanceof Error ? e.message : e} — template ${src.vmid} is on ${src.node}; cloning to ${pc.node} needs its disks on shared storage (or deploy the lab to ${src.node}).`);
          throw e;
        });
      ctx.recordCreated(vmid, type, m.name);
      await waitForTask(ctx, upid, { what: 'Clone', timeoutMs: 120 * 60_000 });
      return { detail: `VM ${vmid}${crossNode ? ` (from ${src.node})` : ''}` };
    },
  });
  return id;
}

export function startStep(pc: PlanCtx, m: MachineSpec, type: GuestType, vmid: number, deps: string[]): string {
  const id = `${m.id}:start`;
  pc.steps.push({
    id,
    machine: m.id,
    title: 'Start',
    group: 'power',
    deps,
    run: async (ctx) => {
      await waitForTask(ctx, await ctx.client.guestStatusAction(pc.node, type, vmid, 'start'), { what: 'Start' });
    },
  });
  return id;
}

/** Eject a setup ISO and delete it from storage (it contains passwords). Never fails the machine. */
export function ejectStep(
  pc: PlanCtx,
  m: MachineSpec,
  vmid: number,
  volid: string,
  slot: string | ((ctx: StepContext) => string | undefined),
  deps: string[],
  keepIf?: (ctx: StepContext) => string | undefined,
): string {
  const id = `${m.id}:cleanup`;
  pc.steps.push({
    id,
    machine: m.id,
    title: 'Remove setup ISO',
    group: 'cleanup',
    deps,
    run: async (ctx) => {
      const keep = keepIf?.(ctx);
      if (keep) return { detail: keep };
      try {
        const s = typeof slot === 'function' ? slot(ctx) : slot;
        if (s) await ctx.client.updateConfig(pc.node, 'qemu', vmid, { [s]: 'none,media=cdrom' });
        const storage = volid.slice(0, volid.indexOf(':'));
        await waitForTask(ctx, await ctx.client.deleteVolume(pc.node, storage, volid), { what: 'Delete setup ISO' });
        return { detail: 'Ejected and deleted' };
      } catch (e) {
        return { warning: `Couldn't remove ${volid} — delete it by hand (it contains passwords): ${e instanceof Error ? e.message : e}` };
      }
    },
  });
  return id;
}

export const bridgeFor = (pc: PlanCtx, m: MachineSpec) => effectiveBridge(pc.spec, m);
