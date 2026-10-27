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

export interface GitError extends Error {
  exitCode?: number;
}

// A git call still running after this long is stopped, so one stuck process can't hold up the review
const TIMEOUT = 30_000;

export function git(cwd: string, args: string[], input?: string, options: { env?: Record<string, string>; timeout?: number } = {}): Promise<string> {
  const { env, timeout = TIMEOUT } = options;
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout, env: env && { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const message = err.killed ? `git ${args[0]} did not finish within ${timeout / 1000} seconds` : stderr.trim() || err.message;
      reject(Object.assign(new Error(message), { exitCode: typeof err.code === 'number' ? err.code : undefined }));
    });
    // git may exit before reading stdin; its result is reported by the callback above
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

// Local and remote branches, the most recently committed to first
export async function branches(root: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  return out
    .split('\n')
    .filter((ref) => ref && !ref.endsWith('/HEAD'))
    .map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ''));
}

// The branch reviews compare with when none is picked
export function defaultBase(refs: string[]): string | undefined {
  return ['main', 'master', 'origin/main', 'origin/master'].find((b) => refs.includes(b));
}

export interface Worktree {
  dir: string;
  branch?: string;
}

// The folders of branches checked out in a worktree
export async function worktrees(root: string): Promise<Map<string, string>> {
  return new Map((await worktreeList(root)).filter((w) => w.branch).map((w): [string, string] => [w.branch!, w.dir]));
}

// Every worktree of the repository, the main one first, with the branch checked out in it
export async function worktreeList(root: string): Promise<Worktree[]> {
  return parseWorktreeList(await git(root, ['worktree', 'list', '--porcelain']));
}

export function parseWorktreeList(out: string): Worktree[] {
  const list: { dir: string; branch?: string; prunable?: boolean }[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push({ dir: line.slice('worktree '.length) });
    else if (line.startsWith('branch refs/heads/') && list.length) list[list.length - 1].branch = line.slice('branch refs/heads/'.length);
    else if (line.startsWith('prunable') && list.length) list[list.length - 1].prunable = true;
  }
  return list.filter((w) => !w.prunable).map(({ dir, branch }) => ({ dir, branch }));
}

function rev(ref: string): string {
  if (ref.startsWith('-')) throw new Error(`Invalid revision "${ref}"`);
  return ref;
}

// The commit a branch, tag or other revision such as HEAD~3 points at, or an error naming it
export async function commitOf(root: string, ref: string): Promise<string> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `${rev(ref)}^{commit}`])).trim();
  } catch {
    throw new Error(`"${ref}" isn't a branch, tag or commit in this repository.`);
  }
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

// Which of these paths, relative to `cwd`, git ignores, or undefined when git can't tell, for example for a path
// inside a submodule. Tracked files are never ignored.
export async function ignoredPaths(cwd: string, paths: string[]): Promise<Set<string> | undefined> {
  if (!paths.length) return new Set();
  try {
    return new Set((await git(cwd, ['check-ignore', '--stdin', '-z'], paths.join('\0') + '\0')).split('\0').filter(Boolean));
  } catch (e) {
    // Exit code 1 means none of them is ignored
    return (e as GitError).exitCode === 1 ? new Set() : undefined;
  }
}

interface Hashed {
  size: number;
  mtimeMs: number;
  id: string;
}

const hashed = new Map<string, Hashed>();

// Ids of files in a worktree that change when the files do, or undefined for ones that are gone. Regular files
// get the blob id git would give them, and with `write` their contents are stored, to diff against later;
// symlinks and submodules get an id of their own. Unchanged files are not hashed again.
export async function hashObjects(dir: string, files: string[], write: boolean): Promise<(string | undefined)[]> {
  const ids: (string | undefined)[] = [];
  const regular: number[] = [];
  // Taken before hashing, so a write while git reads the file can't be cached as the version it hashed
  const stats: { size: number; mtimeMs: number }[] = [];
  await Promise.all(
    files.map(async (file, i) => {
      const full = path.join(dir, file);
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) ids[i] = `link:${await fs.readlink(full)}`;
        else if (stat.isDirectory()) ids[i] = `submodule:${(await git(full, ['rev-parse', 'HEAD']).catch(() => '')).trim()}`;
        else {
          const known = hashed.get(full);
          // A file changed within the same mtime tick as it was hashed can look unchanged, so recent ones are hashed again
          const settled = Date.now() - stat.mtimeMs > 2000;
          if (!write && settled && known?.size === stat.size && known.mtimeMs === stat.mtimeMs) ids[i] = known.id;
          else regular.push(i);
          stats[i] = stat;
        }
      } catch {
        ids[i] = undefined;
      }
    }),
  );
  if (regular.length) {
    const hash = (paths: string[]) => git(dir, ['hash-object', ...(write ? ['-w'] : []), '--stdin-paths'], paths.join('\n') + '\n');
    let out: (string | undefined)[];
    try {
      out = (await hash(regular.map((i) => files[i]))).trim().split('\n');
    } catch {
      // One file that went away fails the whole batch, so hash them one at a time
      out = [];
      for (const i of regular) out.push((await hash([files[i]]).catch(() => undefined))?.trim());
    }
    regular.forEach((i, k) => {
      ids[i] = out[k];
      if (out[k]) remember(hashed, path.join(dir, files[i]), { size: stats[i].size, mtimeMs: stats[i].mtimeMs, id: out[k]! });
    });
  }
  return ids;
}

export function parseRaw(out: string): ChangedFile[] {
  return readRaw(out.split('\0'))[0];
}

// The raw diff records at the start of `parts`, and where the parts after them begin
function readRaw(parts: string[]): [ChangedFile[], number] {
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
  return [files, i];
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
  const args = ['diff', '--raw', '--numstat', '-z', '-M', '--no-abbrev', ...range];
  const parts = (target.dir ? await withOwnIndex(cwd, (env) => git(cwd, args, undefined, { env })) : await git(cwd, args)).split('\0');
  const [raw, end] = readRaw(parts);
  const stats = parseNumstat(parts.slice(end).join('\0'));
  const files = raw.map((f) => ({ ...f, ...stats.get(f.path) }));
  if (!target.dir) return files;
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter((file) => file && !file.endsWith('/'));
  const counts = await mapLimit(untracked, 16, (file) => lineCount(path.join(cwd, file)));
  const deleted = new Map(files.map((f, i) => [f.path, i] as const).filter(([, i]) => files[i].status === 'D'));
  untracked.forEach((file, k) => {
    const gone = deleted.get(file);
    // Removed from the index and written again: one changed file, not a deletion and an addition
    if (gone !== undefined) files[gone] = { ...files[gone], status: 'M', added: counts[k].added };
    else files.push({ path: file, oldPath: file, status: 'A', ...counts[k] });
  });
  return files;
}

const indexes = new Map<string, Promise<string>>();
let links = 0;

// Runs git on a hard link to the worktree's index. A working-tree diff writes refreshed file stats to the index
// it reads, which takes index.lock and can make an agent's `git add` or `git commit` fail at that moment. Git
// replaces the index file rather than writing into it, so the link stays a snapshot.
async function withOwnIndex<T>(cwd: string, run: (env?: Record<string, string>) => Promise<T>): Promise<T> {
  let index: string;
  try {
    if (!indexes.has(cwd)) indexes.set(cwd, git(cwd, ['rev-parse', '--git-path', 'index']).then((out) => path.resolve(cwd, out.trim())));
    index = await indexes.get(cwd)!;
  } catch {
    indexes.delete(cwd);
    return run();
  }
  const own = path.join(path.dirname(index), `prereview-index-${process.pid}-${++links}`);
  try {
    await fs.link(index, own);
  } catch {
    return run();
  }
  try {
    return await run({ GIT_INDEX_FILE: own });
  } finally {
    await fs.rm(own, { force: true });
  }
}

interface Counted {
  size: number;
  mtimeMs: number;
  counts: { added?: number; deleted?: number };
}

const counted = new Map<string, Counted>();

async function lineCount(file: string): Promise<{ added?: number; deleted?: number }> {
  try {
    const stat = await fs.stat(file);
    const known = counted.get(file);
    if (known?.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.counts;
    let counts: { added?: number; deleted?: number } = {};
    if (stat.size <= 8 * 1024 * 1024) {
      const data = await fs.readFile(file);
      if (!data.subarray(0, 8000).includes(0)) {
        const lines = data.toString('utf8').split('\n').length - (data[data.length - 1] === 0x0a || !data.length ? 1 : 0);
        counts = { added: lines, deleted: 0 };
      }
    }
    remember(counted, file, { size: stat.size, mtimeMs: stat.mtimeMs, counts });
    return counts;
  } catch {
    return {};
  }
}

// Keeps caches keyed by file from growing without bound
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= 5000) cache.clear();
  cache.set(key, value);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) results.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return results;
}
