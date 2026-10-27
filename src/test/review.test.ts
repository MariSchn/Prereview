import './stubVscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import * as fake from './fakeVscode';
import { git } from '../git';
import { REVIEWER } from '../model';
import { Review } from '../review';
import { listReviews } from '../reviewsView';

// A repository with `base` committed on main and the review folder ignored, as Prereview leaves it
async function repo(base: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-')));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 't@t']);
  await git(root, ['config', 'user.name', 't']);
  for (const [file, text] of Object.entries({ 'README.md': 'base\n', ...base })) write(file, text);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);
  write('.prereview/.gitignore', '*\n');
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const lines = (...l: string[]) => l.join('\n') + '\n';
const onDisk = (review: Review) => JSON.parse(fs.readFileSync(review.filePath, 'utf8'));

test('a reply keeps everything in the review file, including what Prereview does not show', async () => {
  const r = await repo({ 'a.ts': lines('one', 'two', 'three') });
  try {
    r.write('a.ts', lines('one', 'two', 'three', 'four'));
    r.write(
      '.prereview/main...worktree.json',
      JSON.stringify({
        base: 'main',
        target: null,
        notes: 'kept',
        threads: [
          {
            id: 't1',
            file: 'a.ts',
            startLine: 3,
            endLine: 3,
            snippet: 'three',
            resolved: false,
            severity: 'high',
            comments: [
              { author: REVIEWER, body: 'why?' },
              { author: 'agent', text: 'Because the spec says so.' },
              { author: 'agent', reaction: '+1' },
            ],
          },
          { id: 't2', file: 'a.ts', startLine: 1, resolved: false, comments: [{ author: 'agent', message: 'Heads up' }] },
          { id: 't3', file: path.join(r.root, 'a.ts'), startLine: 2, resolved: false, comments: [{ author: 'agent', body: 'absolute' }] },
          { id: 't4', comments: [{ author: 'agent' }] },
        ],
      }),
    );
    const review = await Review.load(path.join(r.root, '.prereview', 'main...worktree.json'), new fake.Memento());
    assert.deepStrictEqual(
      review.data.threads.map((t) => [t.id, t.file, t.startLine, t.comments.map((c) => c.body), t.unreadable]),
      [
        ['t1', 'a.ts', 3, ['why?', 'Because the spec says so.'], 1],
        ['t2', 'a.ts', 1, ['Heads up'], undefined],
        ['t3', 'a.ts', 2, ['absolute'], undefined],
      ],
    );
    assert.strictEqual(review.data.unreadable, 1);
    await review.reply('t1', 'ok');
    const after = onDisk(review);
    assert.strictEqual(after.notes, 'kept');
    assert.strictEqual(after.threads[0].severity, 'high');
    assert.deepStrictEqual(
      after.threads[0].comments.map((c: any) => c.body ?? c.reaction),
      ['why?', 'Because the spec says so.', '+1', 'ok'],
    );
    assert.deepStrictEqual([after.threads[1].comments[0].body, after.threads[1].snippet], ['Heads up', 'one']);
    assert.deepStrictEqual([after.threads[2].file, after.threads[2].startLine], ['a.ts', 2]);
    assert.deepStrictEqual(after.threads[3], { id: 't4', comments: [{ author: 'agent' }] });
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('only the old and new version of a changed file take comments', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('one', 'two'));
    r.write('new.ts', lines('x'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    const a = review.files.find((f) => f.path === 'a.ts')!;
    const [left, right] = review.diffUris(a);
    assert.deepStrictEqual(review.commentLocation(left), { file: 'a.ts', side: 'base' });
    assert.deepStrictEqual(review.commentLocation(right), { file: 'a.ts', side: 'head' });
    const [empty] = review.diffUris(review.files.find((f) => f.path === 'new.ts')!);
    assert.strictEqual(review.commentLocation(empty), undefined);
    assert.strictEqual(review.fileOf(empty)?.path, 'new.ts');
    await review.setViewed([a], true);
    r.write('a.ts', lines('zero', 'one', 'two'));
    await review.refresh();
    const [snapshot] = review.sinceViewedUris(review.files.find((f) => f.path === 'a.ts')!)!;
    assert.strictEqual(review.commentLocation(snapshot), undefined);
    assert.strictEqual(review.fileOf(snapshot)?.path, 'a.ts');
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('a thread follows its line when lines above it are deleted, and the new line is written back', async () => {
  const code = ['import x', 'const a = 1', '', 'function f() {', '  return a', '}'];
  const r = await repo({ 'a.ts': lines('old') });
  try {
    r.write('a.ts', lines(...code));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 4, endLine: 4 }, 'Why a function?');
    r.write('a.ts', lines(...code.slice(2)));
    await review.refresh();
    assert.deepStrictEqual(review.position(review.data.threads[0]), { start: 2, end: 2, outdated: false });
    await review.syncLines();
    assert.deepStrictEqual([onDisk(review).threads[0].startLine, onDisk(review).threads[0].endLine], [2, 2]);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('a thread on a closing brace stays on its own brace when another one is added above', async () => {
  const before = ['function f(a) {', '  if (a) {', '    return 1;', '  }', '  return 2;', '}'];
  const r = await repo({ 'a.ts': lines('old') });
  try {
    r.write('a.ts', lines(...before));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 4, endLine: 4 }, 'Close this earlier?');
    r.write('a.ts', lines('function f(a) {', '  if (!a) {', '    throw new Error();', '  }', ...before.slice(1)));
    await review.refresh();
    assert.deepStrictEqual(review.position(review.data.threads[0]), { start: 7, end: 7, outdated: false });
    // A change to the commented line marks the thread outdated where its line was
    r.write('a.ts', lines('function f(a) {', '  if (!a) {', '    throw new Error();', '  }', '  if (a) {', '    return 1;', '  } // done', '  return 2;', '}'));
    await review.refresh();
    assert.deepStrictEqual(review.position(review.data.threads[0]), { start: 7, end: 7, outdated: true });
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('a thread moves while its file is edited, before it is saved', async () => {
  const r = await repo({ 'a.ts': lines('old') });
  try {
    r.write('a.ts', lines('a', 'b', 'c', 'target'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 4, endLine: 4 }, 'here');
    const doc = { uri: fake.Uri.file(path.join(r.root, 'a.ts')), isDirty: true, getText: () => lines('c', 'target') };
    fake.workspace.textDocuments.push(doc);
    const moved = new Promise((resolve) => review.onDidChange(resolve));
    fake.editDocument(doc);
    await moved;
    assert.deepStrictEqual(review.position(review.data.threads[0]), { start: 2, end: 2, outdated: false });
    fake.workspace.textDocuments.splice(fake.workspace.textDocuments.indexOf(doc), 1);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('a review file that is not valid JSON keeps the review open on what was last read', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const state = new fake.Memento();
    const review = await Review.open(r.root, 'main', null, state);
    await review.addThread({}, 'general');
    fs.writeFileSync(review.filePath, '{ "base": "main", "target": null, "threads": [ }');
    await review.refresh();
    assert.strictEqual(review.fileError?.line, 1);
    assert.strictEqual(review.data.threads.length, 1);
    await assert.rejects(review.reply(review.data.threads[0].id, 'x'), /isn't valid JSON \(line 1, column \d+\), so the change was not saved/);
    const reopened = await Review.load(review.filePath, state);
    assert.deepStrictEqual([!!reopened.fileError, reopened.data.threads.map((t) => t.comments[0].body)], [true, ['general']]);
    reopened.dispose();
    const [entry] = await listReviews(r.root);
    assert.deepStrictEqual([entry.data.base, entry.data.target, entry.error?.line], ['main', null, 1]);
    fs.writeFileSync(review.filePath, JSON.stringify({ base: 'main', target: null, threads: [] }));
    await review.refresh();
    assert.strictEqual(review.fileError, undefined);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('only your own comments can be edited, and not to nothing', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({}, 'mine');
    const data = onDisk(review);
    data.threads[0].comments.push({ author: 'agent', body: 'theirs' });
    fs.writeFileSync(review.filePath, JSON.stringify(data));
    await review.refresh();
    const [t] = review.data.threads;
    await assert.rejects(review.editComment(t.id, t.comments[1].id, 'x'), /Only your own comments/);
    await assert.rejects(review.editComment(t.id, t.comments[0].id, '  '), /can't be empty/);
    await review.editComment(t.id, t.comments[0].id, 'mine, edited');
    assert.deepStrictEqual(review.data.threads[0].comments.map((c) => c.body), ['mine, edited', 'theirs']);
    review.dispose();
  } finally {
    r.cleanup();
  }
});
