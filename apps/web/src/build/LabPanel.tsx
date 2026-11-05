/** Shown when no machine is selected: where the lab goes, shared logins, and what's on storage. */
import { Copy, Eye, EyeOff, LoaderCircle, RefreshCw, Wrench } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Connection, LabIssue, TargetInventory } from '@proxflow/shared';
import { ActionButton } from '../components/ConfirmButton';
import { Field, PanelSection, Select, TextArea, TextInput } from '../components/form';
import { useFix } from './api';
import { generatePassword, type LabDesign } from './design';
import { Note } from './MachinePanel';

type Props = {
  design: LabDesign;
  setDesign: (fn: (d: LabDesign) => LabDesign) => void;
  connections: Connection[];
  inv?: TargetInventory;
  invLoading: boolean;
  invError?: string;
  issues: LabIssue[];
  onRefreshInventory: () => void;
};

export function LabPanel({ design, setDesign, connections, inv, invLoading, invError, issues, onRefreshInventory }: Props) {
  const [showPw, setShowPw] = useState(false);
  const fix = useFix();
  const t = design.target;
  const setTarget = (patch: Partial<LabDesign['target']>) => setDesign((d) => ({ ...d, target: { ...d.target, ...patch } }));
  const setDefaults = (patch: Partial<LabDesign['defaults']>) => setDesign((d) => ({ ...d, defaults: { ...d.defaults, ...patch } }));
  const storages = (content: string) =>
    (inv?.storages ?? []).map((s) => ({ value: s.name, label: `${s.name}${s.shared ? ' (shared)' : ''}${s.content.includes(content) ? '' : ` — no ${content}`}`, disabled: !s.content.includes(content) && content !== 'import' }));
  const labIssues = issues.filter((i) => !i.machine);

  return (
    <div className="space-y-5">
      <PanelSection title="Lab">
        <Field label="Name" hint="also tags every VM, e.g. pf-ad-lab">
          <TextInput value={design.name} onChange={(name) => setDesign((d) => ({ ...d, name }))} />
        </Field>
      </PanelSection>

      {labIssues.length > 0 && (
        <div className="space-y-1.5">
          {labIssues.map((i, n) => (
            <div key={n} className="space-y-1">
              <Note tone={i.level === 'error' ? 'error' : 'warn'}>{i.message}</Note>
              {i.fix && (
                <ActionButton
                  size="sm"
                  tone="sky"
                  icon={fix.isPending ? LoaderCircle : Wrench}
                  disabled={fix.isPending}
                  onClick={() =>
                    fix.mutate(
                      { conn: t.conn!, fix: i.fix! },
                      { onSuccess: () => toast.success(`${i.fix!.label}: done`), onError: (e) => toast.error(e.message) },
                    )
                  }
                >
                  {i.fix.label}
                </ActionButton>
              )}
            </div>
          ))}
        </div>
      )}

      <PanelSection
        title="Deploy to"
        action={
          <button type="button" onClick={onRefreshInventory} title="Re-read storage, templates and boxes" className="text-zinc-500 hover:text-zinc-200">
            <RefreshCw className={`h-3.5 w-3.5 ${invLoading ? 'animate-spin' : ''}`} />
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <Field label="Connection">
            <Select
              value={t.conn ?? ''}
              options={connections.map((c) => ({ value: c.id, label: `${c.name}${c.status && !c.status.ok ? ' (unreachable)' : ''}` }))}
              placeholder="Add a connection first"
              onChange={(conn) => setDesign((d) => ({ ...d, target: { conn } }))}
            />
          </Field>
          <Field label="Node">
            <Select value={t.node ?? ''} options={(inv?.nodes ?? []).map((n) => ({ value: n.name, label: `${n.name}${n.online ? '' : ' (offline)'}`, disabled: !n.online }))} onChange={(node) => setDesign((d) => ({ ...d, target: { conn: d.target.conn, node } }))} />
          </Field>
        </div>
        {invError && <Note tone="error">{invError}</Note>}
        <Field label="VM disks on">
          <Select value={t.diskStorage ?? ''} options={storages('images')} onChange={(diskStorage) => setTarget({ diskStorage })} />
        </Field>
        <Field label="Setup ISOs on" hint="small, temporary; deleted after setup">
          <Select value={t.isoStorage ?? ''} options={storages('iso')} onChange={(isoStorage) => setTarget({ isoStorage })} />
        </Field>
        <Field label="Default network">
          <Select value={t.bridge ?? ''} options={(inv?.bridges ?? []).map((b) => ({ value: b.name, label: `${b.name}${b.cidr ? ` · ${b.cidr}` : ''}${b.vlanAware ? ' · VLAN-aware' : ''}` }))} onChange={(bridge) => setTarget({ bridge })} />
        </Field>
        {design.machines.some((m) => m.kind === 'linux-vm' && m.source.type === 'catalog') && (
          <Field label="Cloud-image downloads go to" hint="needs internet on the node">
            <Select value={t.importStorage ?? ''} options={storages('import')} onChange={(importStorage) => setTarget({ importStorage })} />
          </Field>
        )}
      </PanelSection>

      <PanelSection title="Logins (all machines unless overridden)">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Linux user">
            <TextInput value={design.defaults.username} onChange={(username) => setDefaults({ username })} mono />
          </Field>
          <Field label="Password">
            <div className="flex gap-1">
              <TextInput value={design.defaults.password} onChange={(password) => setDefaults({ password })} type={showPw ? 'text' : 'password'} mono />
              <IconBtn title={showPw ? 'Hide' : 'Show'} onClick={() => setShowPw((s) => !s)}>
                {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </IconBtn>
            </div>
          </Field>
        </div>
        <div className="space-y-0.5">
          <div className="flex gap-3 whitespace-nowrap text-[11px]">
            <button type="button" className="text-sky-300 hover:underline" onClick={() => setDefaults({ password: generatePassword() })}>
              Generate new
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sky-300 hover:underline"
              onClick={() => navigator.clipboard?.writeText(design.defaults.password).then(() => toast.success('Password copied'))}
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">Windows logs in as Administrator, ESXi as root. Stored in this browser.</p>
        </div>
        <Field label="SSH public key" hint="optional, Linux and containers">
          <TextArea value={design.defaults.sshKey} onChange={(sshKey) => setDefaults({ sshKey })} placeholder="ssh-ed25519 AAAA… you@host" rows={2} />
        </Field>
        <Field label="DNS servers" hint="optional; empty = each network's gateway">
          <TextInput value={design.defaults.dns} onChange={(dns) => setDefaults({ dns })} placeholder="e.g. 10.0.0.53" mono />
        </Field>
      </PanelSection>

      <PanelSection title={`On storage${inv ? ` (${inv.node})` : ''}`}>
        {inv ? (
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-xs">
            {(
              [
                ['Installer ISOs', inv.isos.length],
                ['Boxes (backups)', inv.backups.length],
                ['VM / CT templates', inv.vmTemplates.length],
                ['Container templates', inv.lxcTemplates.length],
                ['Disk images', inv.diskImages.length],
                ['VirtIO drivers', inv.virtioIso ? 'found' : 'not found'],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="text-right tabular-nums text-zinc-200">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-zinc-500">{invLoading ? 'Reading storage…' : 'Choose a connection to see what you can build from.'}</p>
        )}
        <p className="text-[10px] leading-relaxed text-zinc-600">Everything is built from what's already on Proxmox storage — no internet needed.</p>
      </PanelSection>
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
      {children}
    </button>
  );
}
