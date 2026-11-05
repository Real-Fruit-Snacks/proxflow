/** The server's small JSON data files (connections, deployments, box cache): tolerant reads, atomic writes. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Reads a JSON data file, ignoring a byte-order mark (Notepad and PowerShell 5 add one). A file that still
 * can't be parsed is moved aside rather than left to be overwritten by the next save, and null is returned.
 */
export function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch (err) {
    const aside = `${file}.unreadable-${Date.now()}`;
    try {
      renameSync(file, aside);
      console.error(`[server] could not read ${file} (${message(err)}); kept it as ${aside} and started empty`);
    } catch {
      console.error(`[server] could not read ${file}:`, message(err));
    }
    return null;
  }
}

/** Writes via a temporary file and a rename, retrying briefly when antivirus or indexing holds the file. */
export function writeJsonFile(file: string, value: unknown, mode?: number) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode });
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}
