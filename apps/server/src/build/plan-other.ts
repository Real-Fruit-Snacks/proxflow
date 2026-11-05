/** ESXi hosts (nested, from the installer ISO) and LXC containers (template on storage or backup). */
import {
  READY_PORTS,
  effectivePassword,
  effectiveSshKey,
  ipOf,
  parseCidr,
  splitList,
  type EsxiSpec,
  type LxcSpec,
  type PlannedMachine,
} from '@proxflow/shared';
import { parseKv, parseSizeGiB } from '../pve/parse.js';
import { ESXI_BOOT_APPEND, esxiKickstartIso, keysFor } from './payloads/esxi.js';
import { bridgeFor, cloneStep, ejectStep, ensureBoxTemplate, guestTags, startStep, uploadIsoStep, type PlanCtx } from './plan-common.js';
import { StepTimeout, pollUntil, probePort, waitForTask } from './steps.js';

// ───────────────────────── ESXi ─────────────────────────

export function planEsxi(pc: PlanCtx, m: EsxiSpec, vmid: number, mac: string): PlannedMachine {
  const { T, node, spec } = pc;
  const cidr = parseCidr(m.net.cidr)!;
  const ip = ipOf(m.net.cidr!);
  const dns = splitList(m.net.dns || spec.defaults.dns);
  const ks = uploadIsoStep(pc, m, vmid, 'ks', () =>
    esxiKickstartIso(
      { hostname: m.name, rootPassword: effectivePassword(spec, m), ip, cidr, gateway: m.net.gateway, dns: dns.length ? dns : m.net.gateway ? [m.net.gateway] : [], vlan: m.net.vlan },
      { kind: 'esxi', hostname: m.name, ip, vmid },
    ),
  );

  const create = `${m.id}:create`;
  pc.steps.push({
    id: create,
    machine: m.id,
    title: 'Create nested-ESXi VM',
    group: 'create',
    deps: [ks.stepId],
    run: async (ctx) => {
      const upid = await ctx.client.createGuest(node, 'qemu', {
        vmid,
        name: m.name,
        memory: m.memoryMiB,
        cores: m.cores,
        sockets: 1,
        cpu: 'host', // passes VT-x/AMD-V through so ESXi can run its own VMs
        ostype: 'other',
        machine: 'q35',
        bios: 'ovmf',
        efidisk0: `${T.diskStorage}:1,efitype=4m,pre-enrolled-keys=0`,
        sata0: `${T.diskStorage}:${m.diskGiB}`, // ESXi has no VirtIO driver; SATA works out of the box
        sata1: `${m.iso},media=cdrom`,
        sata2: `${ks.volid},media=cdrom`,
        net0: `vmxnet3=${mac},bridge=${bridgeFor(pc, m)}${m.net.vlan ? `,tag=${m.net.vlan}` : ''}`,
        boot: 'order=sata0;sata1',
        onboot: m.onboot ? 1 : 0,
        tags: guestTags(pc),
        description: pc.description,
      });
      ctx.recordCreated(vmid, 'qemu', m.name);
      await waitForTask(ctx, upid, { what: 'Create VM', timeoutMs: 30 * 60_000 });
      return { detail: 'host CPU · SATA disk · vmxnet3 NIC · UEFI' };
    },
  });
  const start = startStep(pc, m, 'qemu', vmid, [create]);

  const boot = `${m.id}:bootopts`;
  pc.steps.push({
    id: boot,
    machine: m.id,
    title: 'Type kickstart boot option',
    group: 'wait',
    deps: [start],
    run: async (ctx) => {
      ctx.detail('Waiting for the ESXi boot menu');
      await ctx.sleep(12_000);
      try {
        await ctx.client.sendKey(node, vmid, 'shift-o');
        await ctx.sleep(1500);
        for (const k of [...keysFor(ESXI_BOOT_APPEND), 'ret']) {
          await ctx.client.sendKey(node, vmid, k);
          await ctx.sleep(80);
        }
        return { detail: `Typed Shift+O and "${ESXI_BOOT_APPEND.trim()}"` };
      } catch (e) {
        return { warning: `Couldn't type at the boot menu (${e instanceof Error ? e.message : e}). Open the console, press Shift+O and add "${ESXI_BOOT_APPEND.trim()}".` };
      }
    },
  });

  const ready = `${m.id}:ready`;
  pc.steps.push({
    id: ready,
    machine: m.id,
    title: 'Install ESXi',
    group: 'wait',
    deps: [boot],
    run: async (ctx) => {
      ctx.setMachine(m.id, { ip });
      ctx.detail(`Installing — waiting for https://${ip} (typically 5–15 min)`);
      try {
        return await pollUntil(ctx, async () => ((await probePort(ctx, 'qemu', vmid, ip, READY_PORTS.esxi)) ? { detail: `ESXi is answering at https://${ip}` } : undefined), {
          intervalMs: 30_000,
          timeoutMs: 45 * 60_000,
          what: 'ESXi',
        });
      } catch (e) {
        if (!(e instanceof StepTimeout)) throw e;
        return {
          warning: `Couldn't reach https://${ip} from ProxFlow. If the installer is sitting at its boot menu, open the console, reboot, press Shift+O and add "${ESXI_BOOT_APPEND.trim()}" — the kickstart CD is still attached.`,
        };
      }
    },
  });
  // Keep KS.CFG attached if the install wasn't confirmed, so the user can finish it by hand.
  ejectStep(pc, m, vmid, ks.volid, 'sata2', [ready], (ctx) => (ctx.stepStatus(ready) === 'warning' ? 'Kept the kickstart CD attached so you can finish the install by hand' : undefined));

  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    label: 'ESXi host',
    vmid,
    type: 'qemu',
    mac,
    ip,
    summary: `${m.cores} vCPU · ${m.memoryMiB / 1024} GiB · ${m.diskGiB} GiB · nested`,
    access: [`https://${ip}/ui — root`, `ssh root@${ip}`],
    readiness: `HTTPS on ${ip}:${READY_PORTS.esxi}`,
  };
}

// ───────────────────────── LXC ─────────────────────────

export function planLxc(pc: PlanCtx, m: LxcSpec, vmid: number, mac: string): PlannedMachine {
  const { T, node, spec } = pc;
  const bridge = bridgeFor(pc, m);
  const staticIp = m.net.ipMode === 'static' && m.net.cidr ? ipOf(m.net.cidr) : undefined;
  const dns = splitList(m.net.dns || spec.defaults.dns);
  const net0 = [
    'name=eth0',
    `bridge=${bridge}`,
    `hwaddr=${mac}`,
    `ip=${staticIp ? m.net.cidr : 'dhcp'}`,
    staticIp && m.net.gateway ? `gw=${m.net.gateway}` : '',
    m.net.vlan ? `tag=${m.net.vlan}` : '',
    'firewall=1',
  ]
    .filter(Boolean)
    .join(',');
  const password = effectivePassword(spec, m);
  const sshKey = effectiveSshKey(spec, m);

  let built: string;
  if (m.source.type === 'vztmpl') {
    const tmpl = m.source.volid;
    built = `${m.id}:create`;
    pc.steps.push({
      id: built,
      machine: m.id,
      title: 'Create container',
      group: 'create',
      deps: [],
      run: async (ctx) => {
        const upid = await ctx.client.createGuest(node, 'lxc', {
          vmid,
          hostname: m.name,
          ostemplate: tmpl,
          rootfs: `${T.diskStorage}:${m.diskGiB}`,
          cores: m.cores,
          memory: m.memoryMiB,
          swap: 512,
          net0,
          ...(dns.length ? { nameserver: dns.join(' ') } : {}),
          ...(password ? { password } : {}),
          ...(sshKey ? { 'ssh-public-keys': sshKey } : {}),
          unprivileged: m.unprivileged ? 1 : 0,
          ...(m.nesting ? { features: 'nesting=1' } : {}),
          onboot: m.onboot ? 1 : 0,
          tags: guestTags(pc),
          description: pc.description,
        });
        ctx.recordCreated(vmid, 'lxc', m.name);
        await waitForTask(ctx, upid, { what: 'Create container', timeoutMs: 30 * 60_000 });
      },
    });
  } else {
    const volid = m.source.volid;
    const b = pc.inv.backups.find((x) => x.volid === volid);
    if (!b) throw new Error(`Backup ${volid} not found`);
    pc.issues.push({ level: 'warning', machine: m.id, message: 'Containers from a backup keep the root password and SSH keys they were built with.' });
    const clone = cloneStep(pc, m, 'lxc', vmid, ensureBoxTemplate(pc, b));
    built = `${m.id}:configure`;
    pc.steps.push({
      id: built,
      machine: m.id,
      title: 'Configure container',
      group: 'create',
      deps: [clone],
      run: async (ctx) => {
        await ctx.client.updateConfig(node, 'lxc', vmid, {
          hostname: m.name,
          cores: m.cores,
          memory: m.memoryMiB,
          net0,
          ...(dns.length ? { nameserver: dns.join(' ') } : {}),
          onboot: m.onboot ? 1 : 0,
          tags: guestTags(pc),
          description: pc.description,
        });
        const cfg = await ctx.client.guestConfig(node, 'lxc', vmid);
        const cur = parseSizeGiB(parseKv(String(cfg.rootfs ?? '')).opts.size);
        if (cur === undefined || cur < m.diskGiB) await waitForTask(ctx, await ctx.client.resize(node, 'lxc', vmid, 'rootfs', `${m.diskGiB}G`), { what: 'Resize rootfs' });
      },
    });
  }

  const start = startStep(pc, m, 'lxc', vmid, [built]);
  pc.steps.push({
    id: `${m.id}:ready`,
    machine: m.id,
    title: 'Wait for network',
    group: 'wait',
    deps: [start],
    run: async (ctx) => {
      try {
        const ip = await pollUntil(
          ctx,
          async () => {
            const ifaces = await ctx.client.lxcInterfaces(node, vmid).catch(() => []);
            const eth = ifaces.find((i) => i.name !== 'lo' && i.inet);
            return eth?.inet ? ipOf(eth.inet) : undefined;
          },
          { intervalMs: 3000, timeoutMs: 3 * 60_000, what: 'an IP address' },
        );
        ctx.setMachine(m.id, { ip });
        return { detail: `Up at ${ip}` };
      } catch (e) {
        if (!(e instanceof StepTimeout)) throw e;
        if (staticIp) ctx.setMachine(m.id, { ip: staticIp });
        return { warning: `Running, but no IP showed up${staticIp ? ` (configured ${staticIp})` : ' — is there a DHCP server on this network?'}` };
      }
    },
  });

  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    label: 'Container',
    vmid,
    type: 'lxc',
    mac,
    ip: staticIp,
    summary: `${m.cores} vCPU · ${m.memoryMiB} MiB · ${m.diskGiB} GiB${m.unprivileged ? ' · unprivileged' : ''}`,
    access: [`ssh root@${staticIp ?? '<ip>'}`, `pct enter ${vmid}  (on ${node})`],
    readiness: 'Proxmox reports its IP (no agent needed)',
  };
}
