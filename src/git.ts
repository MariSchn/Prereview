import { execFile } from 'child_process';

export type Status = 'A' | 'M' | 'D' | 'R';

export interface ChangedFile {
  path: string;
  oldPath: string;
  status: Status;
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
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

export async function revParse(root: string, ref: string): Promise<string> {
  return (await git(root, ['rev-parse', ref])).trim();
}

export async function mergeBase(root: string, a: string, b: string): Promise<string> {
  return (await git(root, ['merge-base', a, b])).trim();
}

export function show(root: string, sha: string, path: string): Promise<string> {
  return git(root, ['show', `${sha}:${path}`]);
}

export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length && parts[i]) {
    const code = parts[i++][0];
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push(code === 'R' ? { path, oldPath, status: 'R' } : { path, oldPath: path, status: 'A' });
    } else {
      const path = parts[i++];
      const status: Status = code === 'A' || code === 'D' ? code : 'M';
      files.push({ path, oldPath: path, status });
    }
  }
  return files;
}

export async function changedFiles(root: string, base: string, target?: string): Promise<ChangedFile[]> {
  if (target) {
    return parseNameStatus(await git(root, ['diff', '--name-status', '-z', '-M', base, target]));
  }
  const tracked = parseNameStatus(await git(root, ['diff', '--name-status', '-z', '-M', base]));
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
    .map((path): ChangedFile => ({ path, oldPath: path, status: 'A' }));
  return [...tracked, ...untracked];
}
