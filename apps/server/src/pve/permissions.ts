/**
 * Turns Proxmox's effective-permission map into a plain summary so the UI can say
 * "this token can see VMs but can't start them" *before* the user stares at an empty map.
 */
import type { PermissionSummary } from '@proxflow/shared';
import type { RawPermissions } from './types.js';

/** True if `priv` is granted on `/` or on/under any of `roots`. */
function hasPriv(perms: RawPermissions, priv: string, roots: string[]): boolean {
  return Object.entries(perms).some(
    ([path, privs]) => privs?.[priv] === 1 && (path === '/' || roots.some((r) => path === r || path.startsWith(`${r}/`))),
  );
}

export function summarizePermissions(perms: RawPermissions): PermissionSummary {
  const vmsRead = hasPriv(perms, 'VM.Audit', ['/vms']);
  const nodesRead = hasPriv(perms, 'Sys.Audit', ['/nodes']);
  const storageRead = hasPriv(perms, 'Datastore.Audit', ['/storage']);
  const power = hasPriv(perms, 'VM.PowerMgmt', ['/vms']);
  const snapshot = hasPriv(perms, 'VM.Snapshot', ['/vms']);
  const clone = hasPriv(perms, 'VM.Clone', ['/vms']) && hasPriv(perms, 'VM.Allocate', ['/vms']);
  const admin = hasPriv(perms, 'Sys.Modify', []) && hasPriv(perms, 'VM.Allocate', ['/vms']);

  const level: PermissionSummary['level'] = !vmsRead ? 'none' : admin ? 'admin' : power || snapshot ? 'operate' : 'read';

  const warnings: string[] = [];
  if (!vmsRead) {
    warnings.push(
      'This identity can\'t see any VMs or containers. In Proxmox go to Datacenter → Permissions → Add and give it the PVEAuditor role (read-only) or PVEVMAdmin (manage) on path "/".',
    );
  } else {
    if (!nodesRead) warnings.push('Missing Sys.Audit on /nodes — network bridges won\'t show up. PVEAuditor on "/" includes it.');
    if (!storageRead) warnings.push('Missing Datastore.Audit — storage won\'t show up. PVEAuditor on "/" includes it.');
    if (!power) warnings.push('Read-only: start/stop/reboot need VM.PowerMgmt (role PVEVMUser or PVEVMAdmin).');
    if (!snapshot) warnings.push('Snapshots need VM.Snapshot (role PVEVMUser or PVEVMAdmin).');
  }

  return { known: true, level, vmsRead, nodesRead, storageRead, power, snapshot, clone, warnings };
}

export const unknownPermissions = (): PermissionSummary => ({
  known: false,
  level: 'unknown',
  vmsRead: true,
  nodesRead: true,
  storageRead: true,
  power: true,
  snapshot: true,
  clone: true,
  warnings: ['Couldn\'t read this identity\'s permissions. The map will show whatever Proxmox lets it see.'],
});
