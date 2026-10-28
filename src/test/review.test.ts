import './stubVscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import * as fake from './fakeVscode';
import { git, repoRoot } from '../git';
import { AGENT_INSTRUCTIONS, REVIEWER } from '../model';
import { Review, contentProvider, createReview } from '../review';
import { ReviewsView, listReviews } from '../reviewsView';

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

test('a thread past the end of its file shows on the last line, outdated, and gets no empty snippet', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('one', 'two', 'three'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({}, 'general');
    const data = onDisk(review);
    data.threads.push({ id: 'far', file: 'a.ts', startLine: 9, resolved: false, comments: [{ author: 'agent', body: 'look here' }] });
    fs.writeFileSync(review.filePath, JSON.stringify(data));
    await review.refresh();
    const far = review.data.threads.find((t) => t.id === 'far')!;
    assert.deepStrictEqual(review.position(far), { start: 4, end: 4, outdated: true });
    await review.reply('far', 'where?');
    assert.strictEqual(onDisk(review).threads.find((t: any) => t.id === 'far').snippet, undefined);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('lines in a file with unsaved edits are not written to the review file', async () => {
  const r = await repo({ 'a.ts': lines('old') });
  try {
    r.write('a.ts', lines('a', 'b', 'c', 'd', 'target'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 5, endLine: 5 }, 'here');
    const doc = { uri: fake.Uri.file(path.join(r.root, 'a.ts')), isDirty: true, getText: () => lines('d', 'target') };
    fake.workspace.textDocuments.push(doc);
    const moved = new Promise((resolve) => review.onDidChange(resolve));
    fake.editDocument(doc);
    await moved;
    assert.strictEqual(review.position(review.data.threads[0])?.start, 2);
    await review.syncLines();
    await review.reply(review.data.threads[0].id, 'more');
    assert.strictEqual(onDisk(review).threads[0].startLine, 5);
    fake.workspace.textDocuments.splice(fake.workspace.textDocuments.indexOf(doc), 1);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits up to five seconds for something the review does in the background, as git can be slow on CI machines
async function until(condition: () => boolean): Promise<void> {
  for (const end = Date.now() + 5000; !condition() && Date.now() < end; ) await sleep(50);
}

// Counts full refreshes, optionally making each one slower
function refreshes(review: Review, delay = 0): () => number {
  let runs = 0;
  const target = review as any;
  const refreshOnce = target.refreshOnce.bind(review);
  target.refreshOnce = async () => {
    runs++;
    await sleep(delay);
    return refreshOnce();
  };
  return () => runs;
}

test('steady file activity delays a refresh only for so long', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    const runs = refreshes(review);
    for (const end = Date.now() + 2000; Date.now() < end; await sleep(100)) {
      r.write('a.ts', lines('two', `${Date.now()}`));
      fake.touch(path.join(r.root, 'a.ts'));
    }
    assert.ok(runs() >= 1, `refreshed ${runs()} times`);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('ignored files never refresh, and code changed in the background waits for the window', async () => {
  const r = await repo({ '.gitignore': '*.log\n', 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({}, 'question');
    const runs = refreshes(review);
    r.write('server.log', 'tick\n');
    fake.touch(path.join(r.root, 'server.log'));
    await sleep(600);
    assert.strictEqual(runs(), 0);
    fake.setFocused(false);
    r.write('a.ts', lines('three'));
    fake.touch(path.join(r.root, 'a.ts'));
    // The agent's reply still shows up while the window is in the background
    const data = onDisk(review);
    data.threads[0].comments.push({ author: 'agent', body: 'answer' });
    fs.writeFileSync(review.filePath, JSON.stringify(data));
    fake.touch(review.filePath);
    await until(() => review.data.threads[0].comments.length === 2);
    assert.deepStrictEqual([runs(), review.data.threads[0].comments.length], [0, 2]);
    fake.setFocused(true);
    await sleep(300);
    assert.strictEqual(runs(), 1);
    assert.strictEqual(review.files.find((f) => f.path === 'a.ts')?.added, 1);
    // Windows can't remove the folder while that refresh still runs git in it
    await review.refresh();
    review.dispose();
  } finally {
    fake.setFocused(true);
    r.cleanup();
  }
});

test("the extension's own write does not redraw the views a second time", async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    let changes = 0;
    review.onDidChange(() => changes++);
    await review.addThread({}, 'general');
    fake.touch(review.filePath);
    await sleep(600);
    assert.strictEqual(changes, 1);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('a reply waits for at most the refresh that is running, however busy the files are', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({}, 'question');
    refreshes(review, 800);
    let started = Date.now();
    await review.refresh();
    const refresh = Date.now() - started;
    // Files change more often than a refresh takes, but less often than refreshes are put off for
    let busy = true;
    const stream = (async () => {
      while (busy) {
        r.write('a.ts', lines('two', `${Date.now()}`));
        fake.touch(path.join(r.root, 'a.ts'));
        await sleep(400);
      }
    })();
    await sleep(2 * refresh);
    started = Date.now();
    await review.reply(review.data.threads[0].id, 'ok');
    const waited = Date.now() - started;
    busy = false;
    await stream;
    assert.ok(waited < 2 * refresh, `the reply waited ${waited} ms, and one refresh takes ${refresh} ms`);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('a file git ignored is refreshed once it is added anyway, and a reply is read at once after a slow refresh', async () => {
  const r = await repo({ '.gitignore': '*.gen.ts\n', 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({}, 'question');
    const runs = refreshes(review);
    r.write('api.gen.ts', lines('x'));
    fake.touch(path.join(r.root, 'api.gen.ts'));
    await sleep(600);
    assert.strictEqual(runs(), 0);
    await git(r.root, ['add', '-f', 'api.gen.ts']);
    fake.touch(path.join(r.root, '.git', 'index'));
    await until(() => review.files.some((f) => f.path === 'api.gen.ts'));
    r.write('api.gen.ts', lines('x', 'y', 'z'));
    fake.touch(path.join(r.root, 'api.gen.ts'));
    await until(() => review.files.find((f) => f.path === 'api.gen.ts')?.added === 3);
    assert.strictEqual(review.files.find((f) => f.path === 'api.gen.ts')?.added, 3);
    // However long the last refresh took, a change to the review file alone is read within a moment
    await review.refresh();
    (review as any).cost = 3000;
    const data = onDisk(review);
    data.threads[0].comments.push({ author: 'agent', body: 'answer' });
    fs.writeFileSync(review.filePath, JSON.stringify(data));
    fake.touch(review.filePath);
    await sleep(600);
    assert.strictEqual(review.data.threads[0].comments.length, 2);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('a review opened from a linked worktree notices branches move, though their refs are outside it', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  const linked = `${r.root}-linked`;
  try {
    await git(r.root, ['worktree', 'add', '-q', '-b', 'feat', linked]);
    fs.writeFileSync(path.join(linked, 'b.ts'), lines('b'));
    await git(linked, ['add', '.']);
    await git(linked, ['commit', '-qm', 'b']);
    const review = await Review.open(linked, 'main', null, new fake.Memento());
    assert.deepStrictEqual(review.files.map((f) => f.path), ['b.ts']);
    // main moves on, and the worktree is rebased onto it: c.ts comes from main, not from this branch
    r.write('c.ts', lines('c'));
    await git(r.root, ['add', 'c.ts']);
    await git(r.root, ['commit', '-qm', 'c']);
    await git(linked, ['rebase', '-q', 'main']);
    fake.touch(path.join(linked, 'b.ts'));
    await sleep(800);
    assert.deepStrictEqual(review.files.map((f) => f.path), ['b.ts']);
    review.dispose();
  } finally {
    await git(r.root, ['worktree', 'remove', '--force', linked]).catch(() => undefined);
    fs.rmSync(linked, { recursive: true, force: true });
    r.cleanup();
  }
});

test('a viewed file is unticked when it changes, and the snapshot shows what it was', async () => {
  const r = await repo({ 'a.ts': lines('one'), 'gone.ts': lines('x') });
  try {
    r.write('a.ts', lines('one', 'two'));
    fs.rmSync(path.join(r.root, 'gone.ts'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    const file = (name: string) => review.files.find((f) => f.path === name)!;
    assert.deepStrictEqual([review.viewState(file('a.ts')), review.viewState(file('gone.ts'))], ['unviewed', 'unviewed']);
    await review.setViewed([file('a.ts'), file('gone.ts')], true);
    assert.deepStrictEqual([review.viewState(file('a.ts')), review.viewState(file('gone.ts'))], ['viewed', 'viewed']);
    r.write('a.ts', lines('one', 'two', 'three'));
    await review.refresh();
    assert.deepStrictEqual([review.viewState(file('a.ts')), review.viewState(file('gone.ts'))], ['updated', 'viewed']);
    const [snapshot] = review.sinceViewedUris(file('a.ts'))!;
    assert.strictEqual(await contentProvider.provideTextDocumentContent(snapshot), lines('one', 'two'));
    await review.setViewed([file('a.ts')], true);
    assert.strictEqual(review.viewState(file('a.ts')), 'viewed');
    await review.setViewed([file('a.ts')], false);
    assert.deepStrictEqual([review.viewState(file('a.ts')), review.sinceViewedUris(file('a.ts'))], ['unviewed', undefined]);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test("a review of a worktree's branch is kept in that worktree, and found from the main checkout", async () => {
  const r = await repo({ 'a.ts': lines('one') });
  // Spelled as git spells worktrees, like the root the extension gets: on Windows without short names like RUNNER~1
  const root = await repoRoot(r.root);
  const worktree = `${root}-agent`;
  try {
    await git(root, ['worktree', 'add', '-q', '-b', 'agent', worktree]);
    fs.writeFileSync(path.join(worktree, 'a.ts'), lines('one', 'uncommitted'));
    const filePath = await createReview(root, 'main', 'agent');
    assert.strictEqual(path.dirname(filePath), path.join(worktree, '.prereview'));
    assert.strictEqual(fs.readFileSync(path.join(worktree, '.prereview', '.gitignore'), 'utf8'), '*\n');
    assert.deepStrictEqual((await listReviews(root)).map((e) => e.filePath), [filePath]);
    // Opened from the main checkout, it still shows the worktree's uncommitted changes
    const review = await Review.load(filePath, new fake.Memento(), root);
    assert.deepStrictEqual([review.targetDir, review.files.map((f) => [f.path, f.added])], [worktree, [['a.ts', 1]]]);
    review.dispose();
    // Starting the same review again opens this one, and one kept in the main checkout is found too
    assert.strictEqual(await createReview(root, 'main', 'agent'), filePath);
    const older = await createReview(root, 'main', null);
    assert.strictEqual(path.dirname(older), path.join(root, '.prereview'));
    assert.deepStrictEqual((await listReviews(root)).map((e) => e.data.target), [null, 'agent']);
    // A review of the working tree belongs to the checkout it was started in
    const theirs = await createReview(worktree, 'main', null);
    assert.strictEqual(path.dirname(theirs), path.join(worktree, '.prereview'));
    assert.deepStrictEqual((await listReviews(root)).map((e) => e.filePath), [older, filePath]);
    assert.deepStrictEqual((await listReviews(worktree)).map((e) => e.filePath), [filePath, theirs]);
  } finally {
    await git(root, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    fs.rmSync(worktree, { recursive: true, force: true });
    r.cleanup();
  }
});

test('a review kept in another checkout reads the replies written there', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  const root = await repoRoot(r.root);
  const worktree = `${root}-agent`;
  try {
    await git(root, ['branch', 'feature']);
    await git(root, ['worktree', 'add', '-q', '-b', 'agent', worktree]);
    // Looked at from the agent's worktree, a review of a branch that isn't checked out stays in the main checkout
    const review = await Review.load(await createReview(root, 'main', 'feature'), new fake.Memento(), worktree);
    await review.addThread({}, 'general');
    const data = onDisk(review);
    data.threads[0].comments.push({ author: 'agent', body: 'answer' });
    fs.writeFileSync(review.filePath, JSON.stringify(data));
    fake.touch(review.filePath);
    await sleep(600);
    assert.strictEqual(review.data.threads[0].comments.length, 2);
    review.dispose();
  } finally {
    await git(root, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    fs.rmSync(worktree, { recursive: true, force: true });
    r.cleanup();
  }
});

test('worktrees without a review are suggested, except the one with the default branch', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  const root = await repoRoot(r.root);
  const worktree = `${root}-agent`;
  const view = new ReviewsView();
  try {
    await git(root, ['worktree', 'add', '-q', '-b', 'agent', worktree]);
    view.setRoot(root);
    await view.refresh();
    assert.deepStrictEqual(view.suggestions, [{ branch: 'agent', dir: worktree }]);
    view.setRoot(worktree);
    await view.refresh();
    assert.deepStrictEqual(view.suggestions, []);
  } finally {
    view.dispose();
    await git(root, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    fs.rmSync(worktree, { recursive: true, force: true });
    r.cleanup();
  }
});

test('agent replies are new until their thread is looked at, and replies already there are not', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('two'));
    const state = new fake.Memento();
    const review = await Review.open(r.root, 'main', null, state);
    await review.addThread({}, 'first');
    await review.addThread({}, 'second');
    const data = onDisk(review);
    data.threads[0].comments.push({ author: 'agent', body: 'answer' });
    fs.writeFileSync(review.filePath, JSON.stringify(data));
    await review.refresh();
    const [first, second] = review.data.threads;
    assert.deepStrictEqual([review.unread(first), review.unread(second)], [1, 0]);
    assert.ok(review.commentTime(first, first.comments[1]));
    review.markRead([first.id]);
    assert.strictEqual(review.unread(first), 0);
    // A reply is new by when Prereview first saw it, whatever time the agent wrote on it
    await sleep(5);
    const later = onDisk(review);
    later.threads[0].comments.push({ author: 'agent', body: 'more', createdAt: '2000-01-01T00:00:00-05:00' });
    fs.writeFileSync(review.filePath, JSON.stringify(later));
    await review.refresh();
    assert.strictEqual(review.unread(review.data.threads[0]), 1);
    review.dispose();
    // A review opened for the first time doesn't count replies that were already there as new
    const fresh = await Review.load(review.filePath, new fake.Memento(), r.root);
    assert.deepStrictEqual([fresh.unread(fresh.data.threads[0]), fresh.commentTime(fresh.data.threads[0], fresh.data.threads[0].comments[1])], [0, undefined]);
    fresh.dispose();
  } finally {
    r.cleanup();
  }
});

test('a suggestion is applied to the lines its thread is on, and the thread is resolved', async () => {
  const r = await repo({ 'a.ts': lines('one') });
  try {
    r.write('a.ts', lines('a', 'b', 'c', 'd'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 2, endLine: 3 }, 'Simpler:\n```suggestion\nbc\n```');
    const [t] = review.data.threads;
    assert.ok(review.canApply(t));
    // A line added above, not yet noticed: the suggestion waits for the thread to move with its lines
    r.write('a.ts', lines('x', 'a', 'b', 'c', 'd'));
    await assert.rejects(review.applySuggestion(t.id, t.comments[0].id), /changed since/);
    assert.strictEqual(fs.readFileSync(path.join(r.root, 'a.ts'), 'utf8'), lines('x', 'a', 'b', 'c', 'd'));
    await review.refresh();
    await review.applySuggestion(t.id, t.comments[0].id);
    assert.strictEqual(fs.readFileSync(path.join(r.root, 'a.ts'), 'utf8'), lines('x', 'a', 'bc', 'd'));
    assert.deepStrictEqual([review.data.threads[0].resolved, review.data.threads[0].comments[1].body], [true, 'Applied the suggestion.']);
    fake.workspace.textDocuments.length = 0;
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test('what changed since a comment and since the hand-off is kept, and lock files are marked', async () => {
  const r = await repo({ 'a.ts': lines('one'), 'b.ts': lines('x') });
  try {
    r.write('a.ts', lines('one', 'two'));
    r.write('package-lock.json', '{}\n');
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 2, endLine: 2 }, 'why two?');
    await review.handOff();
    assert.deepStrictEqual([review.sinceCommentUris(review.data.threads[0]), review.changedSinceHandoff()], [undefined, []]);
    r.write('a.ts', lines('one', 'two', 'three'));
    r.write('b.ts', lines('y'));
    await review.refresh();
    const [before] = review.sinceCommentUris(review.data.threads[0])!;
    assert.strictEqual(await contentProvider.provideTextDocumentContent(before as any), lines('one', 'two'));
    assert.deepStrictEqual(review.changedSinceHandoff().map((f) => f.path), ['a.ts', 'b.ts']);
    const [handedOff] = review.sinceHandoffUris(review.files.find((f) => f.path === 'b.ts')!)!;
    assert.strictEqual(await contentProvider.provideTextDocumentContent(handedOff as any), '');
    assert.deepStrictEqual(review.files.filter((f) => f.generated).map((f) => f.path), ['package-lock.json']);
    // Changed back to its base version, a file leaves the diff but still changed since the hand-off
    r.write('a.ts', lines('one'));
    await review.refresh();
    const changed = review.changedSinceHandoff();
    assert.deepStrictEqual(changed.map((f) => f.path), ['b.ts', 'a.ts']);
    const [was, now] = review.sinceHandoffUris(changed[1])!;
    const text = (uri: unknown) => contentProvider.provideTextDocumentContent(uri as any);
    assert.deepStrictEqual([await text(was), await text(now)], [lines('one', 'two'), lines('one')]);
    review.dispose();
  } finally {
    r.cleanup();
  }
});

test("a review agent gets this version's instructions and where threads are now, and no hand-off is noted", async () => {
  const r = await repo({ 'a.ts': lines('old') });
  try {
    r.write('a.ts', lines('a', 'b', 'c'));
    const review = await Review.open(r.root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 3, endLine: 3 }, 'why c?');
    // A file written by an older version, and lines added above the thread since
    fs.writeFileSync(review.filePath, JSON.stringify({ ...onDisk(review), agentInstructions: 'old' }));
    r.write('a.ts', lines('x', 'y', 'a', 'b', 'c'));
    await review.refresh();
    await review.handOffToReviewAgent();
    const after = onDisk(review);
    assert.deepStrictEqual([after.agentInstructions, after.threads[0].startLine, review.handedOff], [AGENT_INSTRUCTIONS, 5, undefined]);
    review.dispose();
  } finally {
    r.cleanup();
  }
});
