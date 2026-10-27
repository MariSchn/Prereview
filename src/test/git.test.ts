import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { catBlob, changedFiles, git, hashObjects, ignoredPaths, mergeBase, parseNumstat, parseRaw, parseWorktrees, revParse, show } from '../git';

const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);

test('parseRaw handles renames, odd statuses and uncomputed blobs', () => {
  const out = [`:100644 100644 ${SHA} ${SHA} M`, 'a.ts', `:100644 100644 ${SHA} ${SHA} R087`, 'old.ts', 'new.ts', `:100644 100644 ${SHA} ${ZERO} T`, 'link', ''].join('\0');
  assert.deepStrictEqual(parseRaw(out), [
    { path: 'a.ts', oldPath: 'a.ts', status: 'M', blob: SHA },
    { path: 'new.ts', oldPath: 'old.ts', status: 'R', blob: SHA },
    { path: 'link', oldPath: 'link', status: 'M', blob: undefined },
  ]);
});

test('parseNumstat keeps a tab that is part of the file name', () => {
  const stats = parseNumstat('1\t0\ta\tb.ts\0');
  assert.deepStrictEqual([...stats], [['a\tb.ts', { added: 1, deleted: 0 }]]);
});

test('parseWorktrees skips a worktree whose folder is gone', () => {
  const out = 'worktree /wt/x\nHEAD 1\nbranch refs/heads/feat\nprunable gitdir file points to non-existent location\n';
  assert.deepStrictEqual([...parseWorktrees(out)], []);
});

test('parseNumstat handles renames and binary files', () => {
  const stats = parseNumstat(['3\t1\ta.ts', '2\t0\t', 'old.ts', 'new.ts', '-\t-\timg.png', ''].join('\0'));
  assert.deepStrictEqual([...stats], [
    ['a.ts', { added: 3, deleted: 1 }],
    ['new.ts', { added: 2, deleted: 0 }],
    ['img.png', { added: undefined, deleted: undefined }],
  ]);
});

test('parseWorktrees maps branches to their worktree', () => {
  const out = 'worktree /repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /wt/x\nHEAD 2\nbranch refs/heads/feat/x\n\nworktree /wt/y\nHEAD 3\ndetached\n';
  assert.deepStrictEqual([...parseWorktrees(out)], [
    ['main', '/repo'],
    ['feat/x', '/wt/x'],
  ]);
});

test('revisions that look like options are rejected before git sees them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-'));
  const evil = `--output=${path.join(root, 'out')}`;
  await assert.rejects(show(root, evil, 'a.txt'), /Invalid revision/);
  await assert.rejects(revParse(root, evil), /Invalid revision/);
  await assert.rejects(mergeBase(root, 'main', evil), /Invalid revision/);
  await assert.rejects(catBlob(root, evil), /Invalid revision/);
  await assert.rejects(changedFiles(root, evil, { dir: root }), /Invalid revision/);
  assert.deepStrictEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('changedFiles covers committed, working tree and worktree changes', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-')));
  try {
  const run = (...args: string[]) => git(root, args);
  const write = (file: string, text: string) => fs.writeFileSync(path.join(root, file), text);
  await run('init', '-q', '-b', 'main');
  await run('config', 'user.email', 't@t');
  await run('config', 'user.name', 't');
  write('keep.txt', 'keep\n');
  write('edit.txt', 'one\n');
  write('gone.txt', 'gone\n');
  await run('add', '.');
  await run('commit', '-qm', 'base');
  await run('checkout', '-qb', 'feat');
  write('edit.txt', 'two\nthree\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  await run('commit', '-qam', 'feat');
  write('new.txt', 'a\nb\nc');
  fs.mkdirSync(path.join(root, '.prereview'));
  write('.prereview/.gitignore', '*\n');
  write('.prereview/main...worktree.json', '{}');
  await run('worktree', 'add', '-q', '-b', 'agent', '.wt/agent', 'feat');
  fs.writeFileSync(path.join(root, '.wt/agent/agent.txt'), 'hi\n');

  const base = await mergeBase(root, 'main', 'HEAD');
  const sorted = (files: { path: string }[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));
  const [edit] = await hashObjects(root, ['edit.txt'], false);
  const edited = { path: 'edit.txt', oldPath: 'edit.txt', status: 'M', added: 2, deleted: 1 };
  const gone = { path: 'gone.txt', oldPath: 'gone.txt', status: 'D', blob: undefined, added: 0, deleted: 1 };

  assert.deepStrictEqual(sorted(await changedFiles(root, base, { ref: 'feat' })), [{ ...edited, blob: edit }, gone]);
  assert.deepStrictEqual(sorted(await changedFiles(root, base, { dir: root })), [
    { ...edited, blob: edit },
    gone,
    { path: 'new.txt', oldPath: 'new.txt', status: 'A', added: 3, deleted: 0 },
  ]);
  assert.deepStrictEqual(
    sorted(await changedFiles(root, base, { dir: path.join(root, '.wt/agent') })).map((f) => f.path),
    ['agent.txt', 'edit.txt', 'gone.txt'],
  );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function tempRepo(files: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-')));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 't@t']);
  await git(root, ['config', 'user.name', 't']);
  for (const [file, text] of Object.entries(files)) write(file, text);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);
  return { root, write, base: (await git(root, ['rev-parse', 'HEAD'])).trim(), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('changedFiles lists a file that was removed from the index and written again once', async () => {
  const r = await tempRepo({ 'util.ts': 'one\ntwo\n', 'keep.ts': 'x\n' });
  try {
    await git(r.root, ['rm', '-q', 'util.ts']);
    r.write('util.ts', 'one\ntwo\nthree\n');
    assert.deepStrictEqual(await changedFiles(r.root, r.base, { dir: r.root }), [
      { path: 'util.ts', oldPath: 'util.ts', status: 'M', blob: undefined, added: 3, deleted: 2 },
    ]);
  } finally {
    r.cleanup();
  }
});

test('a working-tree diff leaves the index alone, so it never holds index.lock', async () => {
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, `${i}\n`]));
  const r = await tempRepo(files);
  try {
    const index = path.join(r.root, '.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    // Rewriting files with the same content makes git refresh their stats in the index it reads
    await new Promise((resolve) => setTimeout(resolve, 1100));
    for (const [file, text] of Object.entries(files)) r.write(file, text);
    assert.deepStrictEqual(await changedFiles(r.root, r.base, { dir: r.root }), []);
    assert.strictEqual(fs.statSync(index).mtimeMs, before);
    assert.deepStrictEqual(fs.readdirSync(path.join(r.root, '.git')).filter((f) => f.startsWith('prereview-index')), []);
  } finally {
    r.cleanup();
  }
});

test('hashObjects gives every file an id, even when some of them git cannot hash', async (t) => {
  const r = await tempRepo({ 'a.txt': 'a\n' });
  try {
    try {
      fs.symlinkSync('missing.txt', path.join(r.root, 'dangling'));
      fs.symlinkSync('.git', path.join(r.root, 'dir-link'));
    } catch {
      return t.skip('symlinks are not available');
    }
    const [blob] = await hashObjects(r.root, ['a.txt'], false);
    assert.deepStrictEqual(await hashObjects(r.root, ['a.txt', 'dangling', 'dir-link', 'gone.txt'], true), [blob, 'link:missing.txt', 'link:.git', undefined]);
    assert.strictEqual(await catBlob(r.root, blob!), 'a\n');
  } finally {
    r.cleanup();
  }
});

test('git stops a call that runs past its timeout', async () => {
  const r = await tempRepo({ 'a.txt': 'a\n' });
  try {
    await assert.rejects(git(r.root, ['-c', 'alias.wait=!sleep 5', 'wait'], undefined, { timeout: 300 }), /did not finish within 0.3 seconds/);
  } finally {
    r.cleanup();
  }
});

test('ignoredPaths finds the paths git ignores', async () => {
  const r = await tempRepo({ '.gitignore': '*.log\nbuild/\n', 'a.txt': 'a\n' });
  try {
    assert.deepStrictEqual([...(await ignoredPaths(r.root, ['server.log', 'build/out.js', 'a.txt', 'new.ts']))].sort(), ['build/out.js', 'server.log']);
    assert.deepStrictEqual([...(await ignoredPaths(r.root, ['a.txt']))], []);
  } finally {
    r.cleanup();
  }
});
