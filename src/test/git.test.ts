import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { changedFiles, git, mergeBase, parseNameStatus } from '../git';

test('parseNameStatus handles renames and odd statuses', () => {
  assert.deepStrictEqual(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0T\0link\0'), [
    { path: 'a.ts', oldPath: 'a.ts', status: 'M' },
    { path: 'new.ts', oldPath: 'old.ts', status: 'R' },
    { path: 'link', oldPath: 'link', status: 'M' },
  ]);
});

test('changedFiles covers branch and working tree modes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-'));
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
  write('edit.txt', 'two\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  await run('commit', '-qam', 'feat');
  write('new.txt', 'new\n');
  fs.mkdirSync(path.join(root, '.prereview'));
  write('.prereview/.gitignore', '*\n');
  write('.prereview/main...worktree.json', '{}');

  const base = await mergeBase(root, 'main', 'HEAD');
  const byPath = (files: { path: string }[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepStrictEqual(byPath(await changedFiles(root, base, 'feat')), [
    { path: 'edit.txt', oldPath: 'edit.txt', status: 'M' },
    { path: 'gone.txt', oldPath: 'gone.txt', status: 'D' },
  ]);
  assert.deepStrictEqual(byPath(await changedFiles(root, base)), [
    { path: 'edit.txt', oldPath: 'edit.txt', status: 'M' },
    { path: 'gone.txt', oldPath: 'gone.txt', status: 'D' },
    { path: 'new.txt', oldPath: 'new.txt', status: 'A' },
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});
