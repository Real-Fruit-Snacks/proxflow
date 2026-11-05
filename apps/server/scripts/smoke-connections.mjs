// End-to-end check of the connection flow against the running dev stack (pnpm dev).
// Usage: node apps/server/scripts/smoke-connections.mjs [apiBase]
const API = process.argv[2] ?? 'http://localhost:3001/api';
let failures = 0;

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

function check(label, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail && !ok ? `\n      ${detail}` : ''}`);
}

const token = (secret = 'mock-secret', tokenId = 'root@pam!proxflow') => ({ type: 'token', tokenId, secret });
const password = (pw = 'mock', username = 'root@pam') => ({ type: 'password', username, password: pw });
const probe = (url, auth, tls) => call('POST', '/connections/test', { url, auth, tls }).then((r) => r.json);

console.log('\n── saved connections ──');
{
  const { json: list } = await call('GET', '/connections');
  check('mock connection seeded', Array.isArray(list) && list.some((c) => c.id === 'mock'), JSON.stringify(list));
  check('secrets are redacted', list.every((c) => !('secret' in c.auth) && !('password' in c.auth)));
  const { json: topo } = await call('GET', '/topology');
  check('topology has one ok cluster', topo?.clusters?.length === 1 && topo.clusters[0].ok === true, JSON.stringify(topo?.clusters));
  check('node ids are namespaced by connection', topo?.nodes?.every((n) => n.id.startsWith('mock/')));
}

console.log('\n── probe: happy paths ──');
{
  const r = await probe('localhost:8006', token());
  check('bare host "localhost:8006" over http? no — bare host assumes https', r.ok === false && r.code === 'PROTOCOL', JSON.stringify(r));
  const r2 = await probe('http://localhost:8006', token());
  check('http token → ok', r2.ok === true, JSON.stringify(r2));
  check('reports version + cluster + nodes', r2.ok && r2.version && r2.cluster?.name === 'homelab' && r2.nodes?.length === 2, JSON.stringify(r2));
  check('full permissions → admin', r2.ok && r2.permissions.level === 'admin' && r2.permissions.warnings.length === 0, JSON.stringify(r2.permissions));
  check('mock flag detected', r2.ok && r2.mock === true);
  check('url normalised (trailing /api2/json stripped)', (await probe('http://localhost:8006/api2/json/', token())).url === 'http://localhost:8006');

  const ro = await probe('http://localhost:8006', token('readonly', 'root@pam!auditor'));
  check('read-only token → level read with warnings', ro.ok && ro.permissions.level === 'read' && ro.permissions.warnings.length >= 2, JSON.stringify(ro.permissions));

  const pw = await probe('http://localhost:8006', password());
  check('password auth (ticket) → ok', pw.ok === true, JSON.stringify(pw));
  const pwNoRealm = await probe('http://localhost:8006', password('mock', 'root'));
  check('username without realm gets @pam appended', pwNoRealm.ok === true, JSON.stringify(pwNoRealm));
}

console.log('\n── probe: auth failures ──');
{
  const bad = await probe('http://localhost:8006', token('wrong'));
  check('wrong token secret → AUTH_FAILED with token hint', bad.ok === false && bad.code === 'AUTH_FAILED' && /Token ID/.test(bad.hint ?? ''), JSON.stringify(bad));
  const badPw = await probe('http://localhost:8006', password('nope'));
  check('wrong password → AUTH_FAILED with realm hint', badPw.ok === false && badPw.code === 'AUTH_FAILED' && /realm/.test(badPw.hint ?? ''), JSON.stringify(badPw));
  const { status, json } = await call('POST', '/connections/test', { url: 'http://localhost:8006', auth: { type: 'token', tokenId: 'not-a-token-id', secret: 'x' } });
  check('malformed token id → 400 before contacting host', status === 400 && /user@realm!tokenname/.test(json?.error ?? ''), JSON.stringify(json));
}

console.log('\n── probe: TLS ──');
let fingerprint;
{
  const untrusted = await probe('localhost:8007', token());
  check('self-signed https → TLS_UNTRUSTED', untrusted.ok === false && untrusted.code === 'TLS_UNTRUSTED', JSON.stringify(untrusted));
  check('…with certificate details + fingerprint', !!untrusted.certificate?.fingerprint256 && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(untrusted.certificate.fingerprint256), JSON.stringify(untrusted.certificate));
  fingerprint = untrusted.certificate?.fingerprint256;

  const pinned = await probe('localhost:8007', token(), { mode: 'pinned', fingerprint });
  check('pinned to that fingerprint → ok', pinned.ok === true && pinned.tls?.mode === 'pinned', JSON.stringify(pinned));
  const lowerNoColons = fingerprint.replaceAll(':', '').toLowerCase();
  const pinnedLoose = await probe('localhost:8007', token(), { mode: 'pinned', fingerprint: lowerNoColons });
  check('fingerprint accepted in lowercase without colons', pinnedLoose.ok === true, JSON.stringify(pinnedLoose));

  const wrongPin = await probe('localhost:8007', token(), { mode: 'pinned', fingerprint: fingerprint.replace(/^../, fingerprint.startsWith('00') ? '11' : '00') });
  check('wrong pinned fingerprint → TLS_FINGERPRINT_MISMATCH', wrongPin.ok === false && wrongPin.code === 'TLS_FINGERPRINT_MISMATCH' && !!wrongPin.certificate, JSON.stringify(wrongPin));

  const insecure = await probe('localhost:8007', token(), { mode: 'insecure' });
  check('insecure mode → ok', insecure.ok === true && insecure.tls?.mode === 'insecure', JSON.stringify(insecure));

  const tlsToHttp = await probe('https://localhost:8006', token());
  check('https to a plain-http port → PROTOCOL', tlsToHttp.ok === false && tlsToHttp.code === 'PROTOCOL', JSON.stringify(tlsToHttp));
  const httpToTls = await probe('http://localhost:8007', token());
  check('http to an https port → PROTOCOL (expects HTTPS)', httpToTls.ok === false && httpToTls.code === 'PROTOCOL' && /HTTPS/.test(httpToTls.message), JSON.stringify(httpToTls));
}

console.log('\n── probe: network ──');
{
  const refused = await probe('localhost:9999', token());
  check('closed port → UNREACHABLE with 8006 hint', refused.ok === false && refused.code === 'UNREACHABLE' && /8006/.test(refused.hint ?? ''), JSON.stringify(refused));
  const dns = await probe('does-not-exist.invalid', token());
  check('bad hostname → UNREACHABLE (dns)', dns.ok === false && dns.code === 'UNREACHABLE' && /resolve/.test(dns.message), JSON.stringify(dns));
  const invalid = await probe('http://', token());
  check('garbage url → INVALID_URL', invalid.ok === false && invalid.code === 'INVALID_URL', JSON.stringify(invalid));
  const autoPort = await probe('https://localhost', token(), { mode: 'pinned', fingerprint });
  check('"https://localhost" (443 closed) falls back to :8006 and reports its result', autoPort.ok === false && /8006|443/.test(autoPort.url + (autoPort.message ?? '')), JSON.stringify(autoPort));
}

console.log('\n── save / use / remove a second (https + password) connection ──');
{
  const created = await call('POST', '/connections', { name: 'Mock over TLS', url: 'localhost:8007', auth: password(), tls: { mode: 'pinned', fingerprint } });
  check('create → 201', created.status === 201 && created.json?.id, JSON.stringify(created.json));
  const id = created.json?.id;
  const { json: topo } = await call('GET', '/topology');
  check('topology now has two clusters', topo?.clusters?.length === 2 && topo.clusters.every((c) => c.ok), JSON.stringify(topo?.clusters));
  const guest = topo?.nodes?.find((n) => n.id === `${id}/guest:202`);
  check('guest reachable under the new connection id', !!guest, JSON.stringify(topo?.nodes?.map((n) => n.id).slice(0, 5)));

  const act = await call('POST', `/guests/${id}/pve1/lxc/202/start`);
  check('power action through ticket auth (needs CSRF) → upid', act.status === 200 && /^UPID:/.test(act.json?.upid ?? ''), JSON.stringify(act.json));
  if (act.json?.upid) {
    const t = await call('GET', `/tasks/${id}/pve1/${encodeURIComponent(act.json.upid)}?wait=8000`);
    check('task completes', t.json?.status === 'stopped', JSON.stringify(t.json));
  }

  const retest = await call('POST', `/connections/${id}/test`, { url: 'localhost:8007', auth: { type: 'password', username: 'root@pam', password: '' }, tls: { mode: 'pinned', fingerprint } });
  check('re-test with blank password uses the stored one', retest.json?.ok === true, JSON.stringify(retest.json));

  const upd = await call('PUT', `/connections/${id}`, { name: 'Renamed', url: 'localhost:8007', auth: { type: 'password', username: 'root@pam', password: '' }, tls: { mode: 'pinned', fingerprint } });
  check('update keeps working with blank password', upd.status === 200 && upd.json?.name === 'Renamed', JSON.stringify(upd.json));

  const del = await call('DELETE', `/connections/${id}`);
  check('delete → ok', del.json?.ok === true);
  const { json: after } = await call('GET', '/topology');
  check('back to one cluster', after?.clusters?.length === 1);
  const missing = await call('GET', `/tasks/${id}/pve1/UPID:x`);
  check('unknown connection → 404', missing.status === 404, JSON.stringify(missing.json));
}

console.log('\n── request safety ──');
{
  // "%2E%2E" arrives as ".." and URL parsing would fold it away: DELETE …/snapshot/.. would hit the VM itself.
  // (fetch() would normalise the dots away itself, so send the raw path the way curl --path-as-is does.)
  const { request } = await import('node:http');
  const u = new URL(API);
  const dots = await new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, method: 'DELETE', path: `${u.pathname}/guests/mock/pve1/qemu/100/snapshots/%2E%2E`, headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  check('snapshot name ".." is refused', dots.status === 400, dots.text);
  // Any web page can send a "simple" cross-site POST; only same-origin JS can send JSON without a preflight.
  const plain = await fetch(`${API}/guests/mock/pve1/qemu/100/stop`, { method: 'POST' });
  check('a change without a JSON content type is refused', plain.status === 415, String(plain.status));
  const form = await fetch(`${API}/guests/mock/pve1/qemu/100/stop`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  check('…including text/plain from a form', form.status === 415, String(form.status));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
