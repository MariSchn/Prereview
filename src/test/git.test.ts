import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { catBlob, changedFiles, git, hashObjects, mergeBase, parseNumstat, parseRaw, parseWorktrees, revParse, show } from '../git';

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
