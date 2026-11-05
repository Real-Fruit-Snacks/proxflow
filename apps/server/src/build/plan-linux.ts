/** Linux VMs: from a template, a backup ("box"), a disk image on storage, or (online only) a cloud image. */
import {
  LINUX_IMAGES,
  READY_PORTS,
  effectivePassword,
  effectiveSshKey,
  effectiveUsername,
  findDc,
  ipOf,
  linuxFamily,
  splitList,
  type LinuxVmSpec,
  type PlannedMachine,
} from '@proxflow/shared';
import { linuxSeedIso } from './payloads/linux.js';
import {
  bootDisk,
  bridgeFor,
  cloneStep,
  cloudInitDrives,
  ejectStep,
  ensureBoxTemplate,
  freeCdromSlot,
  growDisk,
  guestTags,
  netString,
  nicModel,
  startStep,
  uploadIsoStep,
  type PlanCtx,
} from './plan-common.js';
import { StepTimeout, agentCall, parseStatus, pickIpv4, pollUntil, probePort, waitForTask, type StepContext } from './steps.js';

const STATUS_FILE = '/var/lib/proxflow/status';

export function planLinuxVm(pc: PlanCtx, m: LinuxVmSpec, vmid: number, mac: string): PlannedMachine {
  const { T, node, spec } = pc;
  const bridge = bridgeFor(pc, m);
  const dc = findDc(spec, m);
  const domain = dc?.domain?.fqdn.trim().toLowerCase();
  const dcIp = dc?.net.cidr ? ipOf(dc.net.cidr) : undefined;
  const staticIp = m.net.ipMode === 'static' && m.net.cidr ? ipOf(m.net.cidr) : undefined;
  const user = effectiveUsername(spec, m);
  const password = effectivePassword(spec, m) || undefined;
  const dns = dcIp ? [dcIp] : splitList(m.net.dns || spec.defaults.dns).length ? splitList(m.net.dns || spec.defaults.dns) : m.net.gateway ? [m.net.gateway] : [];

  // 1. setup seed (cloud-init NoCloud)
  const seed = uploadIsoStep(pc, m, vmid, 'seed', () =>
    linuxSeedIso({
      instanceId: `pf-${pc.tag}-${vmid}`,
      hostname: m.name,
      fqdn: domain ? `${m.name}.${domain}` : undefined,
      username: user,
      password,
      sshKeys: effectiveSshKey(spec, m).split(/\r?\n/).map((k) => k.trim()).filter(Boolean),
      mac,
      net: {
        static: Boolean(staticIp),
        cidr: m.net.cidr,
        gateway: m.net.gateway,
        dns,
        search: domain,
        overrideDhcpDns: Boolean(dcIp) && !staticIp,
      },
      family: linuxFamily(m),
      packages: m.packages,
      join: domain && dc ? { domain, password: effectivePassword(spec, dc) } : undefined,
      meta: { kind: 'linux-vm', hostname: m.name, domain, ip: staticIp, vmid },
    }),
  );

  // 2. get a VM
  let built: string;
  const src = m.source;
  if (src.type === 'template' || src.type === 'backup') {
    let from: { vmid: number; node: string; stepId?: string };
    if (src.type === 'template') {
      const t = pc.inv.vmTemplates.find((x) => x.vmid === src.vmid);
      from = { vmid: src.vmid, node: t?.node ?? node };
    } else {
      const b = pc.inv.backups.find((x) => x.volid === src.volid);
      if (!b) throw new Error(`Backup ${src.volid} not found`);
      from = ensureBoxTemplate(pc, b);
    }
    const clone = cloneStep(pc, m, 'qemu', vmid, from);
    built = `${m.id}:configure`;
    pc.steps.push({
      id: built,
      machine: m.id,
      title: 'Configure hardware',
      group: 'create',
      deps: [clone, seed.stepId],
      run: async (ctx) => {
        const cfg = await ctx.client.guestConfig(node, 'qemu', vmid);
        const remove = cloudInitDrives(cfg);
        const slot = freeCdromSlot(cfg, remove);
        ctx.shared.set(`${m.id}:seedSlot`, slot);
        await ctx.client.updateConfig(node, 'qemu', vmid, {
          name: m.name,
          cores: m.cores,
          memory: m.memoryMiB,
          net0: netString(nicModel(cfg), mac, bridge, m.net.vlan),
          [slot]: `${seed.volid},media=cdrom`,
          agent: 'enabled=1',
          onboot: m.onboot ? 1 : 0,
          tags: guestTags(pc),
          description: pc.description,
          ...(remove.length ? { delete: remove.join(',') } : {}),
        });
        const grown = await growDisk(ctx, 'qemu', vmid, bootDisk(cfg), m.diskGiB);
        return { detail: `${m.cores} vCPU · ${m.memoryMiB} MiB · ${grown}${remove.length ? ` · replaced template cloud-init drive` : ''}` };
      },
    });
  } else {
    // disk image already on storage, or a catalog image downloaded first (needs internet on the node)
    let imageVolid: string;
    const deps = [seed.stepId];
    if (src.type === 'disk') {
      imageVolid = src.volid;
    } else {
      const img = LINUX_IMAGES[src.image];
      imageVolid = `${T.importStorage}:import/${img.filename}`;
      const assetId = `asset:img:${src.image}`;
      const present = pc.inv.diskImages.some((v) => v.volid === imageVolid);
      if (!pc.assets.some((a) => a.id === assetId)) {
        pc.assets.push({ id: assetId, label: `${img.label} cloud image`, volid: imageVolid, action: present ? 'reuse' : 'download', detail: present ? 'Already on storage' : `From ${img.url} (needs internet on ${node})` });
        if (!present) {
          pc.steps.push({
            id: assetId,
            title: `Download ${img.label}`,
            group: 'download',
            deps: [],
            run: async (ctx) => {
              const upid = await ctx.client.downloadUrl(node, T.importStorage, { url: img.url, content: 'import', filename: img.filename });
              await waitForTask(ctx, upid, { what: 'Download', timeoutMs: 120 * 60_000 });
            },
          });
        }
      }
      if (!present) deps.push(assetId);
    }
    built = `${m.id}:create`;
    pc.steps.push({
      id: built,
      machine: m.id,
      title: 'Create VM from disk image',
      group: 'create',
      deps,
      run: async (ctx) => {
        ctx.shared.set(`${m.id}:seedSlot`, 'ide2');
        const upid = await ctx.client.createGuest(node, 'qemu', {
          vmid,
          name: m.name,
          memory: m.memoryMiB,
          cores: m.cores,
          sockets: 1,
          cpu: 'x86-64-v2-AES',
          ostype: 'l26',
          scsihw: 'virtio-scsi-single',
          scsi0: `${T.diskStorage}:0,import-from=${imageVolid},discard=on,iothread=1`,
          ide2: `${seed.volid},media=cdrom`,
          net0: netString('virtio', mac, bridge, m.net.vlan),
          boot: 'order=scsi0',
          agent: 'enabled=1',
          serial0: 'socket',
          onboot: m.onboot ? 1 : 0,
          tags: guestTags(pc),
          description: pc.description,
        });
        ctx.recordCreated(vmid, 'qemu', m.name);
        await waitForTask(ctx, upid, { what: 'Create VM', timeoutMs: 60 * 60_000 });
        const grown = await growDisk(ctx, 'qemu', vmid, bootDisk(await ctx.client.guestConfig(node, 'qemu', vmid)), m.diskGiB);
        return { detail: `VM ${vmid} · ${grown}` };
      },
    });
  }

  // 3. boot and wait until it reports in
  const start = startStep(pc, m, 'qemu', vmid, [built]);
  const ready = `${m.id}:ready`;
  pc.steps.push({
    id: ready,
    machine: m.id,
    title: domain ? `Boot and join ${domain}` : 'Boot and apply cloud-init',
    group: 'wait',
    deps: [start],
    run: (ctx) => waitLinuxReady(ctx, { vmid, mac, staticIp, machineId: m.id, dcReadyStep: dc ? `${dc.id}:ready` : undefined, longWait: Boolean(domain) }),
  });
  // The seed slot is decided at run time (a clone may already use ide2), so read it back from shared state.
  ejectStep(pc, m, vmid, seed.volid, (ctx) => ctx.shared.get(`${m.id}:seedSlot`) as string | undefined, [ready]);

  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    label: 'Linux VM',
    vmid,
    type: 'qemu',
    mac,
    ip: staticIp,
    summary: `${m.cores} vCPU · ${m.memoryMiB / 1024} GiB · ${m.diskGiB} GiB${domain ? ` · joins ${domain}` : ''}`,
    access: [`ssh ${user}@${staticIp ?? '<ip>'}`],
    readiness: staticIp ? `guest agent + cloud-init status, else SSH on ${staticIp}:${READY_PORTS.linux}` : 'guest agent + cloud-init status (DHCP: needs the agent)',
  };
}

export async function waitLinuxReady(
  ctx: StepContext,
  o: { vmid: number; mac: string; staticIp?: string; machineId: string; dcReadyStep?: string; longWait: boolean },
) {
  const node = ctx.node;
  const started = Date.now();
  const agentGrace = ctx.timeout(8 * 60_000);
  const statusGrace = ctx.timeout(15 * 60_000);
  let ip = o.staticIp;
  let agentSince: number | undefined;
  let denied: string | undefined;
  let lastStage = '';
  if (ip) ctx.setMachine(o.machineId, { ip });

  try {
    return await pollUntil(
      ctx,
      async () => {
        if (o.dcReadyStep) {
          const s = ctx.stepStatus(o.dcReadyStep);
          if (s === 'failed' || s === 'skipped' || s === 'cancelled') return { warning: 'The domain controller didn\'t come up, so this machine wasn\'t joined.' };
        }
        if (!denied) {
          const r = await agentCall(() => ctx.client.agentInterfaces(node, o.vmid));
          if (r.state === 'denied') denied = r.message;
          if (r.state === 'ok') {
            agentSince ??= Date.now();
            const found = pickIpv4(r.value, o.mac);
            if (found && found !== ip) {
              ip = found;
              ctx.setMachine(o.machineId, { ip });
            }
            const f = await agentCall(() => ctx.client.agentFileRead(node, o.vmid, STATUS_FILE));
            if (f.state === 'ok') {
              const s = parseStatus(f.value.content);
              if (s.stage && s.stage !== lastStage) {
                lastStage = s.stage;
                ctx.detail(s.detail ?? s.stage);
              }
              if (s.stage === 'ready') return { detail: `${s.detail ?? 'Ready'}${ip ? ` · ${ip}` : ''}` };
              if (s.stage === 'warning') return { warning: s.detail ?? 'Finished with a warning' };
              if (s.stage === 'failed') throw new Error(s.detail ?? 'Setup failed inside the VM');
              return undefined;
            }
            if (f.state === 'unsupported' || f.state === 'denied')
              return { warning: `Running${ip ? ` at ${ip}` : ''}, but ProxFlow can't read its setup status (${f.message}).` };
            if (Date.now() - agentSince > statusGrace)
              return { warning: `Running${ip ? ` at ${ip}` : ''}, but cloud-init never reported back — the image may not have cloud-init, so it kept the hostname, users and network it was built with.` };
            ctx.detail(`Guest agent up${ip ? ` (${ip})` : ''} — waiting for cloud-init`);
            return undefined;
          }
        }
        if (o.staticIp && (denied || Date.now() - started > agentGrace)) {
          ctx.detail(`No guest agent — checking SSH on ${o.staticIp}`);
          if (await probePort(ctx, 'qemu', o.vmid, o.staticIp, READY_PORTS.linux)) return { detail: `SSH is answering on ${o.staticIp} (no guest agent in this image)` };
        } else ctx.detail('Booting — waiting for the guest agent');
        return undefined;
      },
      { intervalMs: 10_000, timeoutMs: (o.longWait ? 240 : 30) * 60_000, what: 'the VM to report in' },
    );
  } catch (e) {
    if (!(e instanceof StepTimeout)) throw e;
    if (agentSince) return { warning: `Running${ip ? ` at ${ip}` : ''}, but setup didn't finish in time — check the VM console.` };
    return {
      warning: o.staticIp
        ? `Started, but SSH on ${o.staticIp} never answered and there's no guest agent — check the VM console.`
        : 'Started, but with DHCP and no guest agent ProxFlow can\'t find it — check the VM console for its IP.',
    };
  }
}
