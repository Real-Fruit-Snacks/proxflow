import { toast } from 'sonner';

/**
 * Copies text and says so. The clipboard API only exists on https or localhost, so when ProxFlow is
 * opened by its LAN address (plain http) this falls back to the older select-and-copy route.
 */
export async function copyText(text: string, done: string) {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard API');
    await navigator.clipboard.writeText(text);
    toast.success(done);
    return;
  } catch {
    /* fall back below */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (ok) toast.success(done);
  else toast.error('Couldn\'t copy — select the text and press Ctrl+C');
}
