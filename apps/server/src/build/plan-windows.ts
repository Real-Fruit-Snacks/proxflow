/**
 * Windows Server: unattended install from the installer ISO, or a box (template / backup)
 * configured through the QEMU guest agent. Roles: domain controller, member server, standalone.
 */
import {
  READY_PORTS,
  WINDOWS_VERSIONS,
  effectivePassword,
  findDc,
  ipOf,
  parseCidr,
  splitList,
  type PlannedMachine,
  type WindowsSpec,
} from '@proxflow/shared';
import { toWindowsMac, windowsAnswerIso, windowsSetupScript, type WindowsSetupConfig } from './payloads/windows.js';
import { bootDisk, bridgeFor, cloneStep, ejectStep, ensureBoxTemplate, growDisk, guestTags, netString, nicModel, startStep, uploadIsoStep, type PlanCtx } from './plan-common.js';
import { AGENT_DENIED_HINT, StepTimeout, agentCall, parseStatus, pollUntil, probePort, waitForTask, type StepContext } from './steps.js';

const STATUS_FILE = 'C:\\ProxFlow\\status.txt';
const BOX_SCRIPT = 'C:\\Windows\\Temp\\proxflow-setup.ps1';

export function planWindows(pc: PlanCtx, m: WindowsSpec, vmid: number, mac: string): PlannedMachine {
  const { T, node, spec } = pc;
  const bridge = bridgeFor(pc, m);
  const dc = m.role === 'server' ? findDc(spec, m) : undefined;
  const role: WindowsSetupConfig['role'] = m.role === 'dc' ? 'dc' : dc ? 'member' : 'standalone';
  const c = m.net.ipMode === 'static' ? parseCidr(m.net.cidr) : null;
  const staticIp = c && m.net.cidr ? ipOf(m.net.cidr) : undefined;
  const dcIp = dc?.net.cidr ? ipOf(dc.net.cidr) : undefined;
  const upstream = splitList(m.net.dns || spec.defaults.dns);
  const pw = effectivePassword(spec, m);
  const domain = (m.role === 'dc' ? m.domain : dc?.domain) ?? undefined;
  const netbios = domain?.netbios.trim().toUpperCase();
  const fqdn = domain?.fqdn.trim().toLowerCase();
  const isoPath = m.source.type === 'iso';
  const virtio = isoPath ? pc.inv.virtioIso : undefined;

  const setup: WindowsSetupConfig = {
    instance: `pf-${pc.tag}-${vmid}`,
    computerName: m.name.toUpperCase(),
    adminPassword: pw,
    mac: toWindowsMac(mac),
    net: {
      static: Boolean(staticIp),
      ip: staticIp,
      prefix: c?.prefix,
      gateway: m.net.gateway,
      dns: dcIp ? [dcIp] : upstream.length ? upstream : m.net.gateway ? [m.net.gateway] : [],
    },
    role,
    installDrivers: Boolean(virtio),
    identity: !isoPath,
    ...(m.role === 'dc' && fqdn ? { domain: fqdn, netbios, dsrmPassword: pw, forwarders: upstream } : {}),
    ...(dc && fqdn && netbios && dcIp ? { join: { domain: fqdn, netbios, password: effectivePassword(spec, dc), dcIp } } : {}),
  };

  const port = m.role === 'dc' ? READY_PORTS.dc : READY_PORTS.windows;
  const steps: { ready: string; started: string } = { ready: `${m.id}:ready`, started: '' };
  let agentExpected = true;
  let answerVolid: string | undefined;

  if (m.source.type === 'iso') {
    const src = m.source;
    const ver = WINDOWS_VERSIONS[src.version];
    agentExpected = Boolean(virtio);
    const answer = uploadIsoStep(pc, m, vmid, 'answer', () =>
      windowsAnswerIso(
        { setup, version: src.version, edition: src.edition, productKey: src.productKey, virtio: Boolean(virtio) },
        { kind: 'windows', role, computerName: setup.computerName, domain: fqdn, ip: staticIp, vmid },
      ),
    );
    answerVolid = answer.volid;
    const create = `${m.id}:create`;
    const diskKey = virtio ? 'scsi0' : 'sata0';
    pc.steps.push({
      id: create,
      machine: m.id,
      title: 'Create VM',
      group: 'create',
      deps: [answer.stepId],
      run: async (ctx) => {
        const upid = await ctx.client.createGuest(node, 'qemu', {
          vmid,
          name: m.name,
          memory: m.memoryMiB,
          cores: m.cores,
          sockets: 1,
          cpu: 'x86-64-v2-AES',
          ostype: ver.ostype,
          machine: 'q35',
          bios: 'seabios', // BIOS boot: no "press any key to boot from CD" prompt, so nobody has to touch the console
          ...(virtio
            ? { scsihw: 'virtio-scsi-single', scsi0: `${T.diskStorage}:${m.diskGiB},discard=on,iothread=1` }
            : { sata0: `${T.diskStorage}:${m.diskGiB},discard=on` }),
          sata2: `${src.iso},media=cdrom`,
          ...(virtio ? { sata3: `${virtio},media=cdrom` } : {}),
          sata4: `${answer.volid},media=cdrom`,
          net0: netString(virtio ? 'virtio' : 'e1000e', mac, bridge, m.net.vlan),
          boot: `order=${diskKey};sata2`,
          agent: 'enabled=1',
          onboot: m.onboot ? 1 : 0,
          tags: guestTags(pc),
          description: pc.description,
        });
        ctx.recordCreated(vmid, 'qemu', m.name);
        await waitForTask(ctx, upid, { what: 'Create VM', timeoutMs: 30 * 60_000 });
        return { detail: virtio ? 'VirtIO disk + NIC' : 'No VirtIO ISO on storage — SATA disk + Intel NIC (built-in drivers)' };
      },
    });
    steps.started = startStep(pc, m, 'qemu', vmid, [create]);
  } else {
    const src = m.source;
    let from: { vmid: number; node: string; stepId?: string };
    if (src.type === 'template') {
      from = { vmid: src.vmid, node: pc.inv.vmTemplates.find((t) => t.vmid === src.vmid)?.node ?? node };
    } else {
      const b = pc.inv.backups.find((x) => x.volid === src.volid);
      if (!b) throw new Error(`Backup ${src.volid} not found`);
      from = ensureBoxTemplate(pc, b);
    }
    const clone = cloneStep(pc, m, 'qemu', vmid, from);
    const configure = `${m.id}:configure`;
    pc.steps.push({
      id: configure,
      machine: m.id,
      title: 'Configure hardware',
      group: 'create',
      deps: [clone],
      run: async (ctx) => {
        const cfg = await ctx.client.guestConfig(node, 'qemu', vmid);
        await ctx.client.updateConfig(node, 'qemu', vmid, {
          name: m.name,
          cores: m.cores,
          memory: m.memoryMiB,
          net0: netString(nicModel(cfg), mac, bridge, m.net.vlan),
          agent: 'enabled=1',
          onboot: m.onboot ? 1 : 0,
          tags: guestTags(pc),
          description: pc.description,
        });
        return { detail: await growDisk(ctx, 'qemu', vmid, bootDisk(cfg), m.diskGiB) };
      },
    });
    steps.started = startStep(pc, m, 'qemu', vmid, [configure]);
  }

  const title = role === 'dc' ? `Install and promote to DC of ${fqdn}` : role === 'member' ? `Install and join ${fqdn}` : 'Install Windows';
  pc.steps.push({
    id: steps.ready,
    machine: m.id,
    title: isoPath ? title : title.replace('Install', 'Set up'),
    group: 'wait',
    deps: [steps.started],
    run: (ctx) =>
      waitWindowsReady(ctx, {
        vmid,
        machineId: m.id,
        staticIp,
        port,
        agentExpected,
        boxScript: isoPath ? undefined : windowsSetupScript(setup),
        instance: setup.instance,
        dcReadyStep: dc ? `${dc.id}:ready` : undefined,
        role,
      }),
  });
  if (answerVolid) ejectStep(pc, m, vmid, answerVolid, 'sata4', [steps.ready]);

  const login = role === 'standalone' ? 'Administrator' : `${netbios}\\Administrator`;
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    label: m.role === 'dc' ? 'Domain controller' : 'Windows Server',
    vmid,
    type: 'qemu',
    mac,
    ip: staticIp,
    summary: `${m.cores} vCPU · ${m.memoryMiB / 1024} GiB · ${m.diskGiB} GiB${fqdn ? ` · ${role === 'dc' ? 'DC of' : 'joins'} ${fqdn}` : ''}`,
    access: [`RDP ${staticIp ?? '<ip>'} — ${login}`],
    readiness: agentExpected
      ? `guest agent + setup status${staticIp ? `, else ${port === 389 ? 'LDAP' : 'RDP'} on ${staticIp}` : ''}`
      : staticIp
        ? `${port === 389 ? 'LDAP' : 'RDP'} on ${staticIp}:${port} (no VirtIO ISO → no guest agent)`
        : 'cannot be confirmed (no guest agent, DHCP)',
  };
}

export async function waitWindowsReady(
  ctx: StepContext,
  o: { vmid: number; machineId: string; staticIp?: string; port: number; agentExpected: boolean; boxScript?: string; instance: string; dcReadyStep?: string; role: string },
) {
  const node = ctx.node;
  const started = Date.now();
  // ISO installs take a while before the agent exists (Windows Setup + driver install); boxes boot fast.
  const agentGrace = ctx.timeout((o.boxScript ? 15 : 60) * 60_000);
  let agentUp = false;
  let denied: string | undefined;
  let scriptStarted = false;
  let lastStage = '';
  if (o.staticIp) ctx.setMachine(o.machineId, { ip: o.staticIp });
  ctx.detail(o.boxScript ? 'Booting the box' : 'Windows Setup is running (typically 10–25 min on real hardware)');

  try {
    return await pollUntil(
      ctx,
      async () => {
        if (o.dcReadyStep) {
          const s = ctx.stepStatus(o.dcReadyStep);
          if (s === 'failed' || s === 'skipped' || s === 'cancelled') return { warning: 'The domain controller didn\'t come up, so this machine wasn\'t joined.' };
        }
        if (o.agentExpected && !denied) {
          const ping = await agentCall(() => ctx.client.agentPing(node, o.vmid));
          if (ping.state === 'denied') denied = ping.message;
          if (ping.state === 'ok') {
            if (!agentUp) ctx.detail('Guest agent is up');
            agentUp = true;
            if (o.boxScript && !scriptStarted) {
              ctx.detail('Sending the setup script through the guest agent');
              await ctx.client.agentFileWrite(node, o.vmid, BOX_SCRIPT, o.boxScript);
              await ctx.client.agentExec(node, o.vmid, ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BOX_SCRIPT]);
              scriptStarted = true;
              return undefined;
            }
            const f = await agentCall(() => ctx.client.agentFileRead(node, o.vmid, STATUS_FILE));
            if (f.state === 'ok') {
              const s = parseStatus(f.value.content);
              if (s.instance !== o.instance) return undefined; // left over in the box from an earlier lab
              if (s.stage && s.stage !== lastStage) {
                lastStage = s.stage;
                ctx.detail(s.detail ?? s.stage);
              }
              if (s.stage === 'ready') return { detail: s.detail ?? 'Ready' };
              if (s.stage === 'failed') throw new Error(s.detail ?? 'Setup failed inside Windows');
            } else if (f.state === 'denied' || f.state === 'unsupported') {
              return { warning: `Running, but ProxFlow can't read its setup status (${f.message}). ${AGENT_DENIED_HINT}` };
            }
            return undefined;
          }
        }
        // No agent (none on the box, no VirtIO ISO, or no permission): watch the service port instead.
        const fallback = !o.agentExpected || denied || (!agentUp && Date.now() - started > agentGrace);
        if (fallback && o.staticIp && !o.boxScript) {
          ctx.detail(`No guest agent — waiting for ${o.port === 389 ? 'LDAP' : 'RDP'} on ${o.staticIp}`);
          if (await probePort(ctx, 'qemu', o.vmid, o.staticIp, o.port))
            return o.role === 'member'
              ? { warning: `RDP is answering on ${o.staticIp}, but without a guest agent ProxFlow can't confirm the domain join.` }
              : { detail: `${o.port === 389 ? 'LDAP (Active Directory)' : 'RDP'} is answering on ${o.staticIp}` };
        }
        if (fallback && o.boxScript && !agentUp)
          return { warning: 'This box has no QEMU guest agent, so ProxFlow couldn\'t configure it — it booted with the name, IP and roles it was built with.' };
        return undefined;
      },
      { intervalMs: 15_000, timeoutMs: 240 * 60_000, what: 'Windows to finish setting up' },
    );
  } catch (e) {
    if (!(e instanceof StepTimeout)) throw e;
    return { warning: `Windows didn't report back in time${lastStage ? ` (last stage: ${lastStage})` : ''} — check the VM console.` };
  }
}
