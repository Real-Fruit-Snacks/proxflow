import { AlertTriangle, Trash2, Wand2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  LINUX_IMAGES,
  WINDOWS_EDITIONS,
  WINDOWS_VERSIONS,
  guessFamily,
  looksLikeEsxiIso,
  looksLikeWindowsIso,
  type LabIssue,
  type LinuxImageId,
  type OsFamily,
  type TargetInventory,
  type WindowsEditionId,
  type WindowsSpec,
  type WindowsVersionId,
} from '@proxflow/shared';
import { ConfirmButton } from '../components/ConfirmButton';
import { Checkbox, Field, NumberInput, PanelSection, Segmented, Select, TextArea, TextInput, type Option } from '../components/form';
import { suggestIps, windowsVersionFromIso, type DesignMachine, type LabDesign } from './design';
import { KIND_STYLES, paletteKindOf } from './labels';

type Props = {
  machine: DesignMachine;
  design: LabDesign;
  inv?: TargetInventory;
  issues: LabIssue[];
  onChange: (m: DesignMachine) => void;
  onDelete: () => void;
};

const fileOf = (volid: string) => volid.slice(volid.indexOf(':') + 1).replace(/^(iso|import|vztmpl|backup)\//, '');
const sizeLabel = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(b / 1024 ** 2)} MiB`);

export function MachinePanel({ machine: m, design, inv, issues, onChange, onDelete }: Props) {
  const style = KIND_STYLES[paletteKindOf(m)];
  const Icon = style.icon;
  const set = (patch: Partial<DesignMachine>) => onChange({ ...m, ...patch } as DesignMachine);
  const err = (field: string) => issues.find((i) => i.field === field && i.level === 'error')?.message;
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  const isoOptions = (filter: (n: string) => boolean): Option<string>[] =>
    (inv?.isos ?? []).map((v) => ({ value: v.volid, label: `${fileOf(v.volid)} (${sizeLabel(v.size)})`, group: filter(v.name) ? 'Likely matches' : 'Other ISOs' }));
  const backupOptions = (subtype: 'qemu' | 'lxc'): Option<string>[] =>
    (inv?.backups ?? [])
      .filter((b) => b.subtype === subtype)
      .map((b) => ({ value: b.volid, label: `${b.notes ?? fileOf(b.volid)}${b.template ? '' : ' (VM backup)'}`, group: b.storage }));
  const templateOptions = (type: 'qemu' | 'lxc'): Option<string>[] =>
    (inv?.vmTemplates ?? [])
      .filter((t) => t.type === type)
      .map((t) => ({
        value: String(t.vmid),
        label: `${t.vmid} · ${t.name}${inv && t.node !== inv.node ? ` (on ${t.node})` : ''}`,
        group: t.box ? 'Boxes restored by ProxFlow' : 'Templates',
      }));
  const dcs = design.machines.filter((x): x is DesignMachine & WindowsSpec => x.kind === 'windows' && x.role === 'dc');
  const dcOptions: Option<string>[] = [{ value: 'none', label: 'Not joined' }, ...dcs.map((d) => ({ value: d.id, label: `${d.name} — ${d.domain?.fqdn ?? '?'}` }))];

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${style.tint}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <Field label="Name" error={err('name')}>
            <TextInput value={m.name} onChange={(name) => set({ name })} mono invalid={Boolean(err('name'))} />
          </Field>
          <div className="mt-1 text-[10px] text-zinc-500">{style.label}</div>
        </div>
        <ConfirmButton size="sm" icon={Trash2} confirmLabel="Remove?" onConfirm={onDelete} title="Remove from lab" />
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="space-y-1.5">
          {errors.map((i, n) => (
            <Note key={`e${n}`} tone="error">
              {i.message}
            </Note>
          ))}
          {warnings.map((i, n) => (
            <Note key={`w${n}`} tone="warn">
              {i.message}
            </Note>
          ))}
        </div>
      )}

      {/* ───── source ───── */}
      <PanelSection title="Built from">
        {m.kind === 'linux-vm' && (
          <>
            <Segmented
              value={m.source.type}
              onChange={(t) => {
                const fam: OsFamily = 'family' in m.source ? m.source.family : 'debian';
                if (t === 'backup') set({ source: { type: 'backup', volid: backupOptions('qemu')[0]?.value ?? '', family: fam } });
                if (t === 'template') set({ source: { type: 'template', vmid: Number(templateOptions('qemu')[0]?.value ?? 0), family: fam } });
                if (t === 'disk') set({ source: { type: 'disk', volid: inv?.diskImages[0]?.volid ?? '', family: fam } });
                if (t === 'catalog') set({ source: { type: 'catalog', image: 'ubuntu-24.04' } });
              }}
              options={[
                { value: 'backup', label: 'Box' },
                { value: 'template', label: 'Template' },
                { value: 'disk', label: 'Disk image' },
                { value: 'catalog', label: 'Download' },
              ]}
            />
            {m.source.type === 'backup' && (
              <Field label="Box (backup on storage)" error={err('source')}>
                <Select value={m.source.volid} options={backupOptions('qemu')} placeholder="No VM backups found" onChange={(volid) => set({ source: { type: 'backup', volid, family: guessFamily(volid + (inv?.backups.find((b) => b.volid === volid)?.notes ?? '')) } })} />
              </Field>
            )}
            {m.source.type === 'template' && (
              <Field label="Template" error={err('source')}>
                <Select value={m.source.vmid ? String(m.source.vmid) : ''} options={templateOptions('qemu')} placeholder="No VM templates found" onChange={(v) => set({ source: { type: 'template', vmid: Number(v), family: guessFamily(inv?.vmTemplates.find((t) => t.vmid === Number(v))?.name ?? '') } })} />
              </Field>
            )}
            {m.source.type === 'disk' && (
              <Field label="Disk image (Import storage)" error={err('source')}>
                <Select value={m.source.volid} options={(inv?.diskImages ?? []).map((v) => ({ value: v.volid, label: `${fileOf(v.volid)} (${sizeLabel(v.size)})`, group: v.storage }))} placeholder="No disk images found" onChange={(volid) => set({ source: { type: 'disk', volid, family: guessFamily(volid) } })} />
              </Field>
            )}
            {m.source.type === 'catalog' && (
              <Field label="Cloud image" hint="needs internet on the Proxmox node">
                <Select value={m.source.image} options={(Object.keys(LINUX_IMAGES) as LinuxImageId[]).map((k) => ({ value: k, label: LINUX_IMAGES[k].label }))} onChange={(image) => set({ source: { type: 'catalog', image } })} />
              </Field>
            )}
            {m.source.type !== 'catalog' && (
              <Help>
                Needs cloud-init in the image to set the name, user and IP. With the QEMU guest agent ProxFlow also follows setup progress; without
                it, ProxFlow checks SSH on the static IP.
              </Help>
            )}
            {m.source.type !== 'catalog' && (
              <Field label="OS family" hint="for the AD join packages and firewall defaults">
                <Segmented value={m.source.family} onChange={(family) => set({ source: { ...m.source, family } as typeof m.source })} options={[{ value: 'debian', label: 'Debian / Ubuntu' }, { value: 'rhel', label: 'RHEL / Rocky / Alma' }]} />
              </Field>
            )}
            <Field label="Extra packages" hint="optional — needs a reachable repo or mirror">
              <TextInput value={m.packages.join(', ')} onChange={(v) => set({ packages: v.split(/[\s,]+/).filter(Boolean) })} placeholder="e.g. htop, git" mono />
            </Field>
          </>
        )}

        {m.kind === 'lxc' && (
          <>
            <Segmented
              value={m.source.type}
              onChange={(t) =>
                set({ source: t === 'vztmpl' ? { type: 'vztmpl', volid: inv?.lxcTemplates[0]?.volid ?? '' } : { type: 'backup', volid: backupOptions('lxc')[0]?.value ?? '' } })
              }
              options={[
                { value: 'vztmpl', label: 'Container template' },
                { value: 'backup', label: 'Box (backup)' },
              ]}
            />
            <Field label={m.source.type === 'vztmpl' ? 'Template on storage' : 'Container backup'} error={err('source')}>
              <Select
                value={m.source.volid}
                options={m.source.type === 'vztmpl' ? (inv?.lxcTemplates ?? []).map((v) => ({ value: v.volid, label: fileOf(v.volid), group: v.storage })) : backupOptions('lxc')}
                placeholder="Nothing found on storage"
                onChange={(volid) => set({ source: { ...m.source, volid } })}
              />
            </Field>
            <div className="flex gap-4">
              <Checkbox checked={m.unprivileged} onChange={(unprivileged) => set({ unprivileged })} label="Unprivileged" />
              <Checkbox checked={m.nesting} onChange={(nesting) => set({ nesting })} label="Nesting (Docker etc.)" />
            </div>
          </>
        )}

        {m.kind === 'windows' && (
          <>
            <Segmented
              value={m.source.type}
              onChange={(t) => {
                if (t === 'iso') {
                  const iso = inv?.isos.find((v) => looksLikeWindowsIso(v.name));
                  set({ source: { type: 'iso', iso: iso?.volid ?? '', version: iso ? windowsVersionFromIso(iso.name) : '2022', edition: 'standard-desktop' } });
                }
                if (t === 'backup') set({ source: { type: 'backup', volid: backupOptions('qemu')[0]?.value ?? '' } });
                if (t === 'template') set({ source: { type: 'template', vmid: Number(templateOptions('qemu')[0]?.value ?? 0) } });
              }}
              options={[
                { value: 'iso', label: 'ISO install' },
                { value: 'backup', label: 'Box' },
                { value: 'template', label: 'Template' },
              ]}
            />
            {m.source.type === 'iso' ? (
              <>
                <Field label="Installer ISO" error={err('iso')}>
                  <Select
                    value={m.source.iso}
                    options={isoOptions(looksLikeWindowsIso)}
                    placeholder="No ISOs found"
                    onChange={(iso) => set({ source: { ...(m.source as Extract<WindowsSpec['source'], { type: 'iso' }>), iso, version: windowsVersionFromIso(fileOf(iso)) } })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Version">
                    <Select value={m.source.version} options={(Object.keys(WINDOWS_VERSIONS) as WindowsVersionId[]).map((k) => ({ value: k, label: WINDOWS_VERSIONS[k].label.replace('Windows ', '') }))} onChange={(version) => set({ source: { ...(m.source as Extract<WindowsSpec['source'], { type: 'iso' }>), version } })} />
                  </Field>
                  <Field label="Edition">
                    <Select value={m.source.edition} options={(Object.keys(WINDOWS_EDITIONS) as WindowsEditionId[]).map((k) => ({ value: k, label: WINDOWS_EDITIONS[k].label }))} onChange={(edition) => set({ source: { ...(m.source as Extract<WindowsSpec['source'], { type: 'iso' }>), edition } })} />
                  </Field>
                </div>
                <Field label="Product key" hint="leave blank for Evaluation media">
                  <TextInput value={m.source.productKey ?? ''} onChange={(productKey) => set({ source: { ...(m.source as Extract<WindowsSpec['source'], { type: 'iso' }>), productKey: productKey || undefined } })} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" mono />
                </Field>
                <p className="text-[10px] leading-relaxed text-zinc-500">
                  {inv?.virtioIso ? `VirtIO drivers from ${fileOf(inv.virtioIso)} are attached automatically.` : 'No VirtIO driver ISO on storage — built-in SATA/Intel drivers are used and there is no guest agent.'}
                </p>
              </>
            ) : m.source.type === 'backup' ? (
              <Field label="Windows box (backup)" error={err('source')}>
                <Select value={m.source.volid} options={backupOptions('qemu')} placeholder="No VM backups found" onChange={(volid) => set({ source: { type: 'backup', volid } })} />
              </Field>
            ) : (
              <Field label="Windows template" error={err('source')}>
                <Select value={m.source.vmid ? String(m.source.vmid) : ''} options={templateOptions('qemu')} placeholder="No templates found" onChange={(v) => set({ source: { type: 'template', vmid: Number(v) } })} />
              </Field>
            )}
            {m.source.type !== 'iso' && (
              <Help>
                Set up through the QEMU guest agent: name, IP and Administrator password, then the DC promotion or domain join. A box without the agent
                boots exactly as it was built.
              </Help>
            )}
          </>
        )}

        {m.kind === 'esxi' && (
          <>
            <Field label="ESXi installer ISO" error={err('iso')}>
              <Select value={m.iso} options={isoOptions(looksLikeEsxiIso)} placeholder="No ISOs found" onChange={(iso) => set({ iso })} />
            </Field>
            <p className="text-[10px] leading-relaxed text-zinc-500">
              Experimental: ProxFlow types the kickstart boot option for you. If that misses, the console shows the ESXi boot menu — press Shift+O and add <span className="font-mono text-zinc-400">ks=cdrom:/KS.CFG</span>.
            </p>
          </>
        )}
      </PanelSection>

      {/* ───── domain ───── */}
      {m.kind === 'windows' && m.role === 'dc' && (
        <PanelSection title="Active Directory">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Field label="Domain" error={err('domain')}>
              <TextInput
                value={m.domain?.fqdn ?? ''}
                onChange={(fqdn) => {
                  const auto = !m.domain?.netbios || m.domain.netbios === (m.domain.fqdn.split('.')[0] ?? '').toUpperCase().slice(0, 15);
                  set({ domain: { fqdn, netbios: auto ? (fqdn.split('.')[0] ?? '').toUpperCase().slice(0, 15) : (m.domain?.netbios ?? '') } });
                }}
                placeholder="lab.internal"
                mono
              />
            </Field>
            <Field label="NetBIOS" error={err('netbios')}>
              <div className="w-28">
                <TextInput value={m.domain?.netbios ?? ''} onChange={(netbios) => set({ domain: { fqdn: m.domain?.fqdn ?? '', netbios: netbios.toUpperCase() } })} mono />
              </div>
            </Field>
          </div>
          <p className="text-[10px] text-zinc-500">The lab password becomes the domain Administrator password (and the DSRM password).</p>
        </PanelSection>
      )}
      {(m.kind === 'linux-vm' || (m.kind === 'windows' && m.role === 'server')) && (
        <PanelSection title="Domain">
          <Field label="Join" hint={dcs.length ? 'or drag from the card\'s bottom dot to a DC' : 'add a domain controller first'} error={err('join')}>
            <Select value={m.joinDomainOf ?? 'none'} options={dcOptions} onChange={(v) => set({ joinDomainOf: v === 'none' ? undefined : v })} />
          </Field>
        </PanelSection>
      )}

      {/* ───── resources ───── */}
      <PanelSection title="Resources">
        <div className="grid grid-cols-3 gap-2">
          <Field label="CPU" error={err('cores')}>
            <NumberInput value={m.cores} onChange={(cores) => set({ cores })} min={1} suffix="cores" />
          </Field>
          <Field label="Memory" error={err('memoryMiB')}>
            <NumberInput value={m.memoryMiB / 1024} onChange={(g) => set({ memoryMiB: Math.round(g * 1024) })} min={0.25} step={0.5} suffix="GiB" />
          </Field>
          <Field label="Disk" error={err('diskGiB')}>
            <NumberInput value={m.diskGiB} onChange={(diskGiB) => set({ diskGiB })} min={1} suffix="GiB" />
          </Field>
        </div>
        <Checkbox checked={m.onboot} onChange={(onboot) => set({ onboot })} label="Start when the Proxmox node boots" />
      </PanelSection>

      {/* ───── network ───── */}
      <PanelSection title="Network">
        <div className="grid grid-cols-[1fr_88px] gap-2">
          <Field label="Bridge" error={err('bridge')}>
            <Select
              value={m.net.bridge ?? ''}
              options={[{ value: '', label: `Lab default (${design.target.bridge ?? '—'})` }, ...(inv?.bridges ?? []).map((b) => ({ value: b.name, label: `${b.name}${b.cidr ? ` · ${b.cidr}` : ''}` }))]}
              onChange={(bridge) => set({ net: { ...m.net, bridge: bridge || undefined } })}
            />
          </Field>
          <Field label="VLAN" error={err('vlan')}>
            <NumberInput value={m.net.vlan ?? NaN} onChange={(v) => set({ net: { ...m.net, vlan: Number.isFinite(v) ? v : undefined } })} min={1} max={4094} />
          </Field>
        </div>
        <Segmented value={m.net.ipMode} onChange={(ipMode) => set({ net: { ...m.net, ipMode } })} options={[{ value: 'static', label: 'Static IP' }, { value: 'dhcp', label: 'DHCP' }]} />
        {m.net.ipMode === 'static' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Address" error={err('cidr')}>
              <div className="flex gap-1">
                <TextInput value={m.net.cidr ?? ''} onChange={(cidr) => set({ net: { ...m.net, cidr } })} placeholder="192.168.1.50/24" mono invalid={Boolean(err('cidr'))} />
                <button
                  type="button"
                  title="Suggest a free address"
                  onClick={() => {
                    const others = { ...design, machines: design.machines.filter((x) => x.id !== m.id) };
                    const [cidr] = suggestIps(others, inv, 1);
                    const bridge = inv?.bridges.find((b) => b.name === (m.net.bridge || design.target.bridge));
                    if (cidr) set({ net: { ...m.net, cidr, gateway: m.net.gateway || bridge?.gateway } });
                  }}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <Wand2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </Field>
            <Field label="Gateway" error={err('gateway')}>
              <TextInput value={m.net.gateway ?? ''} onChange={(gateway) => set({ net: { ...m.net, gateway: gateway || undefined } })} placeholder="192.168.1.1" mono />
            </Field>
          </div>
        )}
        <Field label="DNS servers" hint={m.kind === 'linux-vm' || m.kind === 'windows' ? 'domain members use their DC automatically' : 'empty = lab default'} error={err('dns')}>
          <TextInput value={m.net.dns ?? ''} onChange={(dns) => set({ net: { ...m.net, dns: dns || undefined } })} placeholder={design.defaults.dns || 'lab default'} mono />
        </Field>
      </PanelSection>

      {/* ───── login ───── */}
      <PanelSection title="Login">
        <Checkbox
          checked={!m.credentials}
          onChange={(useDefaults) => set({ credentials: useDefaults ? undefined : { username: '', password: '', sshKey: '' } })}
          label="Use the lab's login defaults"
          hint={m.kind === 'windows' ? 'Administrator / lab password' : m.kind === 'esxi' ? 'root / lab password' : `${design.defaults.username} / lab password`}
        />
        {m.credentials && (
          <div className="space-y-2">
            {m.kind === 'linux-vm' && (
              <Field label="Username" error={err('username')}>
                <TextInput value={m.credentials.username ?? ''} onChange={(username) => set({ credentials: { ...m.credentials, username } })} placeholder={design.defaults.username} mono />
              </Field>
            )}
            <Field label="Password" error={err('password')}>
              <TextInput value={m.credentials.password ?? ''} onChange={(password) => set({ credentials: { ...m.credentials, password } })} placeholder="lab default" type="password" />
            </Field>
            {(m.kind === 'linux-vm' || m.kind === 'lxc') && (
              <Field label="SSH public key">
                <TextArea value={m.credentials.sshKey ?? ''} onChange={(sshKey) => set({ credentials: { ...m.credentials, sshKey } })} placeholder="ssh-ed25519 AAAA… (empty = lab default)" rows={2} />
              </Field>
            )}
          </div>
        )}
      </PanelSection>
    </div>
  );
}

const Help = ({ children }: { children: ReactNode }) => <p className="text-[10px] leading-relaxed text-zinc-500">{children}</p>;

export function Note({ tone, children }: { tone: 'error' | 'warn'; children: ReactNode }) {
  const Icon = tone === 'error' ? XCircle : AlertTriangle;
  return (
    <div className={`flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] leading-snug ${tone === 'error' ? 'border-rose-500/30 bg-rose-500/5 text-rose-200' : 'border-amber-500/25 bg-amber-500/5 text-amber-200/90'}`}>
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
