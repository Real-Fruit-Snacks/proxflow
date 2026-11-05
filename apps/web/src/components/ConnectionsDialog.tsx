import clsx from 'clsx';
import {
  Check,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  Lock,
  Plug,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { Connection, ConnectionInput, ProbeResult, TlsConfig } from '@proxflow/shared';
import { useDeleteConnection, useSaveConnection, useTestConnection } from '../api';
import { Badge, type Tone } from './Badge';
import { ActionButton, ConfirmButton } from './ConfirmButton';

type Props = { open: boolean; onClose: () => void; connections: Connection[] };

type FormState = {
  name: string;
  url: string;
  authType: 'token' | 'password';
  tokenId: string;
  secret: string;
  username: string;
  password: string;
  tls: TlsConfig;
};

const emptyForm = (): FormState => ({ name: '', url: '', authType: 'token', tokenId: '', secret: '', username: 'root@pam', password: '', tls: { mode: 'system' } });

const formFrom = (c: Connection): FormState => ({
  name: c.name,
  url: c.url,
  authType: c.auth.type,
  tokenId: c.auth.type === 'token' ? c.auth.tokenId : '',
  secret: '',
  username: c.auth.type === 'password' ? c.auth.username : 'root@pam',
  password: '',
  tls: c.tls,
});

const toInput = (f: FormState): ConnectionInput => ({
  name: f.name.trim() || undefined,
  url: f.url.trim(),
  auth: f.authType === 'token' ? { type: 'token', tokenId: f.tokenId.trim(), secret: f.secret } : { type: 'password', username: f.username.trim(), password: f.password },
  tls: f.tls,
});

const TOKEN_ID = /^[^\s!@]+@[^\s!@]+![^\s!@]+$/;

export function ConnectionsDialog({ open, onClose, connections }: Props) {
  const firstRun = connections.length === 0;
  const [selected, setSelected] = useState<string>('new');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probedInput, setProbedInput] = useState<string>(''); // JSON of the input the last probe used

  const test = useTestConnection();
  const save = useSaveConnection();
  const remove = useDeleteConnection();

  const current = useMemo(() => connections.find((c) => c.id === selected), [connections, selected]);

  // Reset the form whenever a different connection is picked (or the dialog opens).
  useEffect(() => {
    if (!open) return;
    setForm(current ? formFrom(current) : emptyForm());
    setProbe(null);
    setProbedInput('');
  }, [open, selected, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const input = toInput(form);
  const inputKey = JSON.stringify({ ...input, id: current?.id });
  const tokenIdOk = form.authType !== 'token' || TOKEN_ID.test(form.tokenId.trim());
  const secretsOk = current ? true : form.authType === 'token' ? !!form.secret : !!form.password;
  const canTest = !!form.url.trim() && tokenIdOk && (form.authType === 'token' ? !!form.tokenId.trim() : !!form.username.trim()) && secretsOk;
  const busy = test.isPending || save.isPending || remove.isPending;
  const lastProbeIsCurrent = probe !== null && probedInput === inputKey;

  async function runTest(overrideTls?: TlsConfig): Promise<ProbeResult | null> {
    const i = overrideTls ? { ...input, tls: overrideTls } : input;
    const key = JSON.stringify({ ...i, id: current?.id });
    try {
      const r = await test.mutateAsync({ id: current?.id, input: i });
      setProbe(r);
      setProbedInput(key);
      if (r.ok) {
        // Adopt what the server actually connected to (normalised URL, auto-detected port).
        setForm((f) => ({ ...f, url: r.url, name: f.name || (r.cluster.standalone ? r.nodes[0]?.name ?? '' : r.cluster.name), tls: r.tls }));
      }
      return r;
    } catch (err) {
      setProbe({ ok: false, url: form.url, code: 'HTTP_ERROR', message: err instanceof Error ? err.message : String(err) });
      setProbedInput(key);
      return null;
    }
  }

  async function trust(fingerprint: string) {
    const tls: TlsConfig = { mode: 'pinned', fingerprint };
    set('tls', tls);
    await runTest(tls);
  }

  async function handleSave() {
    let r: ProbeResult | null = lastProbeIsCurrent ? probe : null;
    if (!r) r = await runTest();
    if (!r || !r.ok) return; // the result card explains why
    // "Save & connect" also switches a connection that was turned off back on.
    const finalInput: ConnectionInput = { ...toInput({ ...form, url: r.url, tls: r.tls }), name: form.name.trim() || (r.cluster.standalone ? r.nodes[0]?.name : r.cluster.name), enabled: true };
    try {
      const saved = await save.mutateAsync({ id: current?.id, input: finalInput });
      toast.success(`${current ? 'Updated' : 'Connected to'} ${saved.name}`);
      if (firstRun) onClose();
      else setSelected(saved.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemove() {
    if (!current) return;
    try {
      await remove.mutateAsync(current.id);
      toast.success(`Removed ${current.name}`);
      setSelected('new');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="flex max-h-[calc(100vh-2rem)] w-[min(980px,100%)] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/70"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-300">
            <Plug className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">{firstRun ? 'Connect to Proxmox' : 'Connections'}</h2>
            <p className="text-xs text-zinc-500">
              {firstRun
                ? 'Point ProxFlow at a Proxmox VE host or cluster. Nothing leaves this machine — credentials stay on the ProxFlow server.'
                : 'Each connection is a cluster or standalone host and gets its own row on the map.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close (Esc)">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {!firstRun && (
            <aside className="scroll-thin w-64 shrink-0 overflow-y-auto border-r border-zinc-800 p-2">
              {connections.map((c) => (
                <ConnectionRow key={c.id} c={c} active={selected === c.id} onClick={() => setSelected(c.id)} />
              ))}
              <button
                type="button"
                onClick={() => setSelected('new')}
                className={clsx(
                  'mt-1 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-xs transition-colors',
                  selected === 'new' ? 'border-sky-500/50 bg-sky-500/10 text-sky-200' : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
                )}
              >
                <Plus className="h-3.5 w-3.5" /> Add connection
              </button>
            </aside>
          )}

          <main className="scroll-thin min-w-0 flex-1 overflow-y-auto p-5">
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
                <Field label="Name" hint="optional">
                  <TextInput value={form.name} onChange={(v) => set('name', v)} placeholder="homelab" />
                </Field>
                <Field label="Host" hint="just the address is fine — https and port 8006 are assumed">
                  <TextInput value={form.url} onChange={(v) => set('url', v)} placeholder="192.168.1.10  ·  pve.lan  ·  https://pve.example.com:8006" mono autoFocus={firstRun} />
                </Field>
              </div>

              <div>
                <div className="mb-2 flex gap-1 rounded-lg bg-zinc-900 p-1">
                  <Segment active={form.authType === 'token'} onClick={() => set('authType', 'token')} icon={KeyRound}>
                    API token <span className="text-zinc-500">· recommended</span>
                  </Segment>
                  <Segment active={form.authType === 'password'} onClick={() => set('authType', 'password')} icon={User}>
                    Username &amp; password
                  </Segment>
                </div>

                {form.authType === 'token' ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Token ID" hint="user@realm!tokenname" error={form.tokenId && !tokenIdOk ? 'Must look like root@pam!proxflow' : undefined}>
                      <TextInput value={form.tokenId} onChange={(v) => set('tokenId', v)} placeholder="root@pam!proxflow" mono />
                    </Field>
                    <Field label="Secret" hint={current?.auth.type === 'token' ? 'leave blank to keep the saved one' : 'shown once when the token is created'}>
                      <TextInput value={form.secret} onChange={(v) => set('secret', v)} placeholder={current?.auth.type === 'token' ? '••••••••  (unchanged)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'} mono type="password" />
                    </Field>
                    <p className="text-[11px] leading-relaxed text-zinc-500 sm:col-span-2">
                      In Proxmox: <span className="text-zinc-400">Datacenter → Permissions → API Tokens → Add</span>. Untick <em>Privilege Separation</em> so the token inherits the user's
                      permissions, or give the token its own role under <span className="text-zinc-400">Permissions → Add → API Token Permission</span> (PVEAuditor on / = the map; add
                      PVEVMAdmin on / to manage VMs, and PVEDatastoreAdmin on /storage to build labs).
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Username" hint="include the realm">
                      <TextInput value={form.username} onChange={(v) => set('username', v)} placeholder="root@pam" mono />
                    </Field>
                    <Field label="Password" hint={current?.auth.type === 'password' ? 'leave blank to keep the saved one' : undefined}>
                      <TextInput value={form.password} onChange={(v) => set('password', v)} placeholder={current?.auth.type === 'password' ? '••••••••  (unchanged)' : ''} type="password" />
                    </Field>
                    <p className="text-[11px] leading-relaxed text-zinc-500 sm:col-span-2">
                      <span className="text-zinc-400">@pam</span> for Linux users (root), <span className="text-zinc-400">@pve</span> for users created in Proxmox. Accounts with two-factor
                      authentication can't log in this way — create an API token for them instead. ProxFlow renews the login ticket automatically.
                    </p>
                  </div>
                )}
              </div>

              {form.tls.mode !== 'system' && (
                <div className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2 text-xs', form.tls.mode === 'pinned' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200' : 'border-amber-500/40 bg-amber-500/5 text-amber-200')}>
                  {form.tls.mode === 'pinned' ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">
                    {form.tls.mode === 'pinned' ? (
                      <>
                        Certificate pinned <span className="font-mono text-[11px] text-emerald-300/80">{form.tls.fingerprint}</span>
                      </>
                    ) : (
                      'TLS verification disabled — anyone on the network could impersonate this host.'
                    )}
                  </span>
                  <button type="button" className="shrink-0 text-zinc-400 hover:text-zinc-200" onClick={() => set('tls', { mode: 'system' })}>
                    {form.tls.mode === 'pinned' ? 'Forget' : 'Re-enable'}
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <ActionButton tone="zinc" onClick={() => runTest()} disabled={!canTest || busy} icon={test.isPending ? LoaderCircle : Plug} className={test.isPending ? '[&>svg]:animate-spin' : ''}>
                  Test connection
                </ActionButton>
                <ActionButton tone="sky" onClick={handleSave} disabled={!canTest || busy} icon={save.isPending ? LoaderCircle : Check} className={save.isPending ? '[&>svg]:animate-spin' : ''}>
                  {current ? 'Save changes' : 'Save & connect'}
                </ActionButton>
                {current && (
                  <ConfirmButton tone="zinc" icon={Trash2} onConfirm={handleRemove} disabled={busy} confirmLabel="Remove connection?" className="ml-auto">
                    Remove
                  </ConfirmButton>
                )}
              </div>

              {test.isPending && (
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Contacting {form.url.trim() || 'host'}…
                </div>
              )}
              {!test.isPending && probe && <ProbeCard probe={probe} onTrust={trust} onInsecure={() => runTest({ mode: 'insecure' })} busy={busy} />}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── pieces ─────────────────────────

function ConnectionRow({ c, active, onClick }: { c: Connection; active: boolean; onClick: () => void }) {
  const s = c.status;
  const dot = !c.enabled ? 'bg-zinc-700' : !s ? 'bg-zinc-500' : s.ok ? 'bg-emerald-400' : 'bg-rose-400';
  let host = c.url;
  try {
    host = new URL(c.url).host;
  } catch {
    /* keep raw */
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'mb-1 flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
        active ? 'border-sky-500/50 bg-sky-500/10' : 'border-transparent hover:border-zinc-800 hover:bg-zinc-900',
      )}
    >
      <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', dot)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-zinc-100">{c.name}</span>
        <span className="block truncate font-mono text-[10px] text-zinc-500">{host}</span>
        <span className="mt-1 flex flex-wrap gap-1">
          <Badge>{c.auth.type}</Badge>
          {c.tls.mode === 'pinned' && <Badge tone="emerald">pinned</Badge>}
          {c.tls.mode === 'insecure' && <Badge tone="amber">no tls check</Badge>}
          {s?.mock && <Badge tone="violet">mock</Badge>}
        </span>
        {s && !s.ok && <span className="mt-1 block truncate text-[10px] text-rose-300/80">{s.error}</span>}
      </span>
    </button>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-baseline gap-2">
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        {hint && !error && <span className="truncate text-[10px] text-zinc-500">{hint}</span>}
        {error && <span className="truncate text-[10px] text-rose-300">{error}</span>}
      </span>
      {children}
    </label>
  );
}

function TextInput({ value, onChange, placeholder, mono, type = 'text', autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string; autoFocus?: boolean }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      autoComplete={type === 'password' ? 'new-password' : 'off'}
      className={clsx(
        'h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500/60 focus:outline-none',
        mono && 'font-mono text-[13px]',
      )}
    />
  );
}

function Segment({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof KeyRound; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-zinc-800 text-zinc-100 shadow' : 'text-zinc-500 hover:text-zinc-300',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{children}</span>
    </button>
  );
}

const LEVEL_TONE: Record<string, Tone> = { admin: 'emerald', operate: 'emerald', read: 'sky', none: 'rose', unknown: 'zinc' };
const LEVEL_LABEL: Record<string, string> = { admin: 'full access', operate: 'can manage VMs', read: 'read-only', none: 'no access', unknown: 'permissions unknown' };

function ProbeCard({ probe, onTrust, onInsecure, busy }: { probe: ProbeResult; onTrust: (fp: string) => void; onInsecure: () => void; busy: boolean }) {
  if (probe.ok) {
    const p = probe.permissions;
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
          <Check className="h-4 w-4" />
          Connected to Proxmox VE {probe.version}
          {probe.mock && <Badge tone="violet">mock</Badge>}
        </div>
        <div className="mt-2 grid gap-1.5 text-zinc-300">
          <div>
            <span className="text-zinc-500">{probe.cluster.standalone ? 'Standalone node' : 'Cluster'}:</span> <span className="font-medium text-zinc-100">{probe.cluster.name}</span>
            {!probe.cluster.standalone && !probe.cluster.quorate && <Badge tone="rose" className="ml-2">no quorum</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-zinc-500">Nodes:</span>
            {probe.nodes.map((n) => (
              <span key={n.name} className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-px font-mono text-[11px] text-zinc-200">
                <span className={clsx('h-1.5 w-1.5 rounded-full', n.online ? 'bg-emerald-400' : 'bg-rose-400')} />
                {n.name}
              </span>
            ))}
            {probe.nodes.length === 0 && <span className="text-zinc-500">none visible</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Permissions:</span>
            <Badge tone={LEVEL_TONE[p.level] ?? 'zinc'}>{LEVEL_LABEL[p.level] ?? p.level}</Badge>
          </div>
          {p.warnings.map((w) => (
            <div key={w} className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-amber-200/90">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Lock className="h-3 w-3" />
            {probe.url.startsWith('https:')
              ? probe.tls.mode === 'pinned'
                ? 'TLS · pinned to this certificate'
                : probe.tls.mode === 'insecure'
                  ? 'TLS · verification disabled'
                  : 'TLS · certificate trusted by this machine'
              : 'Plain HTTP (no encryption)'}
            <span className="ml-auto font-mono">{probe.url}</span>
          </div>
        </div>
      </div>
    );
  }

  const tlsIssue = probe.code === 'TLS_UNTRUSTED' || probe.code === 'TLS_FINGERPRINT_MISMATCH';
  const cert = probe.certificate;
  return (
    <div className={clsx('rounded-xl border p-4 text-xs', tlsIssue && probe.code === 'TLS_UNTRUSTED' ? 'border-amber-500/40 bg-amber-500/5' : 'border-rose-500/40 bg-rose-500/5')}>
      <div className={clsx('flex items-center gap-2 text-sm font-semibold', tlsIssue && probe.code === 'TLS_UNTRUSTED' ? 'text-amber-200' : 'text-rose-200')}>
        {tlsIssue ? <ShieldAlert className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
        {probe.message}
      </div>
      {probe.hint && <p className="mt-1.5 leading-relaxed text-zinc-300">{probe.hint}</p>}

      {tlsIssue && cert && (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
            <dt className="text-zinc-500">Issued to</dt>
            <dd className="truncate font-mono text-zinc-200">{cert.subject}</dd>
            <dt className="text-zinc-500">Issued by</dt>
            <dd className="truncate font-mono text-zinc-200">{cert.selfSigned ? 'itself (self-signed)' : cert.issuer}</dd>
            {cert.altNames && (
              <>
                <dt className="text-zinc-500">Names</dt>
                <dd className="truncate font-mono text-zinc-200">{cert.altNames.replaceAll('DNS:', '').replaceAll('IP Address:', '')}</dd>
              </>
            )}
            <dt className="text-zinc-500">Valid until</dt>
            <dd className="font-mono text-zinc-200">{cert.validTo}</dd>
            <dt className="text-zinc-500">SHA-256</dt>
            <dd className="select-all break-all font-mono text-[10.5px] leading-relaxed text-sky-200">{cert.fingerprint256}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ActionButton tone="emerald" icon={ShieldCheck} onClick={() => onTrust(cert.fingerprint256)} disabled={busy}>
              {probe.code === 'TLS_FINGERPRINT_MISMATCH' ? 'Trust the new certificate' : 'Trust this certificate'}
            </ActionButton>
            <button type="button" onClick={onInsecure} disabled={busy} className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">
              connect without verifying (not recommended)
            </button>
          </div>
        </div>
      )}
      {tlsIssue && !cert && <p className="mt-2 text-zinc-400">Couldn't fetch the certificate to show it — try again.</p>}
      <div className="mt-2 font-mono text-[10px] text-zinc-600">{probe.url}</div>
    </div>
  );
}
