import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export type Status = 'A' | 'M' | 'D' | 'R';

export interface ChangedFile {
  path: string;
  oldPath: string;
  status: Status;
  added?: number;
  deleted?: number;
  blob?: string;
}

export function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
    // git may exit before reading stdin; its result is reported by the callback above
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function branches(root: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  return out
    .split('\n')
    .filter((ref) => ref && !ref.endsWith('/HEAD'))
    .map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ''));
}

export async function worktrees(root: string): Promise<Map<string, string>> {
  return parseWorktrees(await git(root, ['worktree', 'list', '--porcelain']));
}

export function parseWorktrees(out: string): Map<string, string> {
  const byBranch = new Map<string, string>();
  let dir: string | undefined;
  let branch: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      dir = line.slice('worktree '.length);
      branch = undefined;
    } else if (line.startsWith('branch refs/heads/') && dir) {
      branch = line.slice('branch refs/heads/'.length);
      byBranch.set(branch, dir);
    } else if (line.startsWith('prunable') && branch) {
      byBranch.delete(branch);
    }
  }
  return byBranch;
}

function rev(ref: string): string {
  if (ref.startsWith('-')) throw new Error(`Invalid revision "${ref}"`);
  return ref;
}

export async function revParse(root: string, ref: string): Promise<string> {
  return (await git(root, ['rev-parse', rev(ref)])).trim();
}

export async function mergeBase(root: string, a: string, b: string): Promise<string> {
  return (await git(root, ['merge-base', rev(a), rev(b)])).trim();
}

export async function show(root: string, sha: string, file: string): Promise<string> {
  return git(root, ['show', `${rev(sha)}:${file}`]);
}

export async function catBlob(root: string, sha: string): Promise<string> {
  return git(root, ['cat-file', 'blob', rev(sha)]);
}

export async function hashObjects(dir: string, files: string[], write: boolean): Promise<string[]> {
  if (!files.length) return [];
  const out = await git(dir, ['hash-object', ...(write ? ['-w'] : []), '--stdin-paths'], files.join('\n') + '\n');
  return out.trim().split('\n');
}

export function parseRaw(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length && parts[i].startsWith(':')) {
    const [, , , sha, code] = parts[i++].slice(1).split(' ');
    const blob = /^0+$/.test(sha) ? undefined : sha;
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = parts[i++];
      const file = parts[i++];
      files.push(code[0] === 'R' ? { path: file, oldPath, status: 'R', blob } : { path: file, oldPath: file, status: 'A', blob });
    } else {
      const file = parts[i++];
      const status: Status = code[0] === 'A' || code[0] === 'D' ? code[0] : 'M';
      files.push({ path: file, oldPath: file, status, blob });
    }
  }
  return files;
}

export function parseNumstat(out: string): Map<string, { added?: number; deleted?: number }> {
  const stats = new Map<string, { added?: number; deleted?: number }>();
  const parts = out.split('\0');
  let i = 0;
  while (i < parts.length && parts[i]) {
    const line = parts[i++];
    const a = line.indexOf('\t');
    const b = line.indexOf('\t', a + 1);
    if (a < 0 || b < 0) continue;
    const added = line.slice(0, a);
    const deleted = line.slice(a + 1, b);
    const key = line.slice(b + 1) || (i++, parts[i++]);
    const count = (n: string) => (n === '-' ? undefined : Number(n));
    stats.set(key, { added: count(added), deleted: count(deleted) });
  }
  return stats;
}

export async function changedFiles(root: string, base: string, target: { ref?: string; dir?: string }): Promise<ChangedFile[]> {
  const cwd = target.dir ?? root;
  const range = target.ref ? [rev(base), rev(target.ref)] : [rev(base)];
  const [raw, numstat] = await Promise.all([
    git(cwd, ['diff', '--raw', '-z', '-M', '--no-abbrev', ...range]),
    git(cwd, ['diff', '--numstat', '-z', '-M', ...range]),
  ]);
  const stats = parseNumstat(numstat);
  const files = parseRaw(raw).map((f) => ({ ...f, ...stats.get(f.path) }));
  if (!target.dir) return files;
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((file) => file && !file.endsWith('/'));
  for (const file of untracked) {
    files.push({ path: file, oldPath: file, status: 'A', ...(await lineCount(path.join(cwd, file))) });
  }
  return files;
}

async function lineCount(file: string): Promise<{ added?: number; deleted?: number }> {
  try {
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) return {};
    const data = await fs.readFile(file);
    if (data.subarray(0, 8000).includes(0)) return {};
    const lines = data.toString('utf8').split('\n').length - (data[data.length - 1] === 0x0a || !data.length ? 1 : 0);
    return { added: lines, deleted: 0 };
  } catch {
    return {};
  }
}
