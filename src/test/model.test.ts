import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import {
  REVIEWER,
  ReviewDocument,
  fileError,
  follow,
  locate,
  parseReview,
  readPair,
  reviewFileName,
  reviewMarkdown,
  reviewFilePath,
  serializeReview,
  threadStatus,
} from '../model';

test('locate keeps a thread whose snippet still matches', () => {
  assert.deepStrictEqual(locate(['a', 'b', 'c'], 'b', 2), { start: 2, end: 2, ambiguous: false });
});

test('locate finds a snippet that moved, and flags a guess between several copies', () => {
  assert.deepStrictEqual(locate(['x', 'y', 'foo', 'bar'], 'foo\nbar', 1), { start: 3, end: 4, ambiguous: false });
  const lines = ['x', 'foo', 'bar', 'y', 'y', 'y', 'foo', 'bar'];
  assert.deepStrictEqual(locate(lines, 'foo\nbar', 6), { start: 7, end: 8, ambiguous: true });
  assert.deepStrictEqual(locate(lines, 'foo\nbar', 3), { start: 2, end: 3, ambiguous: true });
});

test('locate returns undefined when the snippet is gone', () => {
  assert.strictEqual(locate(['a', 'b'], 'c', 1), undefined);
});

test('parseReview reads line, file, base-side and general threads', () => {
  const data = parseReview(
    JSON.stringify({
      title: 'Add caching',
      base: 'main',
      threads: [
        { id: 't1', file: 'a.ts', startLine: 3, endLine: 1, comments: [{ body: 'hi' }, { nope: 1 }] },
        { id: 't2', file: 'a.ts', side: 'base', startLine: 2, snippet: 'old', comments: [{ author: REVIEWER, body: 'why?' }] },
        { id: 't3', file: 'b.ts', snippet: 'ignored', comments: [{ body: 'file' }] },
        { id: 't4', side: 'base', comments: [{ body: 'general' }] },
        { id: 't5', file: 'c.ts', startLine: 1, comments: [] },
      ],
    }),
  );
  assert.deepStrictEqual(data.title, 'Add caching');
  assert.deepStrictEqual(data.description, '');
  assert.strictEqual(data.target, null);
  assert.deepStrictEqual(
    data.threads.map(({ id, file, side, startLine, endLine, snippet }) => ({ id, file, side, startLine, endLine, snippet })),
    [
      { id: 't1', file: 'a.ts', side: undefined, startLine: 3, endLine: 3, snippet: undefined },
      { id: 't2', file: 'a.ts', side: 'base', startLine: 2, endLine: 2, snippet: 'old' },
      { id: 't3', file: 'b.ts', side: undefined, startLine: undefined, endLine: undefined, snippet: undefined },
      { id: 't4', file: undefined, side: undefined, startLine: undefined, endLine: undefined, snippet: undefined },
    ],
  );
  assert.deepStrictEqual(
    data.threads[0].comments.map(({ author, body, createdAt }) => ({ author, body, createdAt })),
    [{ author: 'agent', body: 'hi', createdAt: undefined }],
  );
});

test('parseReview normalizes paths and ignores a byte order mark', () => {
  const text =
    '\uFEFF' +
    JSON.stringify({
      base: 'main',
      threads: [
        { id: 't1', file: './src/a.ts', startLine: '4', comments: [{ body: 'x' }] },
        { id: 't2', file: 'src\\b.ts', startLine: 2, comments: [{ body: 'y' }] },
      ],
    });
  const data = parseReview(text);
  assert.deepStrictEqual(
    data.threads.map((t) => [t.file, t.startLine]),
    [
      ['src/a.ts', 4],
      ['src/b.ts', 2],
    ],
  );
});

test('parseReview turns threads on files outside the repository into general comments', () => {
  const threads = ['../secret.txt', 'src/../../x', '/etc/passwd', 'C:\\x.txt', 'src/ok..ts'].map((file, i) => ({
    id: `t${i}`,
    file,
    startLine: 1,
    comments: [{ body: 'x', createdAt: 5 }],
  }));
  const data = parseReview(JSON.stringify({ base: 'main', threads }));
  assert.deepStrictEqual(
    data.threads.map((t) => [t.file, t.startLine]),
    [[undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], ['src/ok..ts', 1]],
  );
  assert.strictEqual(data.threads[0].comments[0].createdAt, undefined);
});

test('parseReview gives agent threads without ids a stable, unique id', () => {
  const text = JSON.stringify({ base: 'main', threads: [{ file: 'a.ts', startLine: 1, comments: [{ body: 'x' }] }, { id: 'dup', comments: [{ body: 'a' }] }, { id: 'dup', comments: [{ body: 'b' }] }] });
  const [first, ...rest] = parseReview(text).threads;
  assert.match(first.id, /^[0-9a-f]{8}$/);
  assert.strictEqual(parseReview(text).threads[0].id, first.id);
  assert.notStrictEqual(rest[0].id, rest[1].id);
});

test('threadStatus follows who spoke last', () => {
  const thread = (authors: string[], resolved = false) => ({ id: 'x', resolved, comments: authors.map((author, i) => ({ id: `${i}`, author, body: '' })) });
  assert.strictEqual(threadStatus(thread([REVIEWER])), 'awaitingAgent');
  assert.strictEqual(threadStatus(thread([REVIEWER, 'agent'])), 'awaitingYou');
  assert.strictEqual(threadStatus(thread(['agent'])), 'awaitingYou');
  assert.strictEqual(threadStatus(thread(['agent'], true)), 'resolved');
});

test('serializeReview round-trips with instructions first and threads in a fixed key order', () => {
  const data = parseReview(JSON.stringify({ base: 'main', target: 'feat/x', threads: [{ comments: [{ body: 'b' }], resolved: true, id: 'i' }] }));
  const text = serializeReview(data);
  const parsed = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(parsed), ['agentInstructions', 'title', 'description', 'base', 'target', 'threads']);
  assert.deepStrictEqual(Object.keys(parsed.threads[0]), ['id', 'resolved', 'comments']);
  assert.deepStrictEqual(parseReview(text), data);
});

test('reviewFileName is filesystem safe', () => {
  assert.strictEqual(reviewFileName('origin/main', 'feat/x'), 'origin-main...feat-x.json');
  assert.strictEqual(reviewFileName('main', null), 'main...worktree.json');
});

test('reviewFilePath skips a file that belongs to another pair, and stops at one it cannot read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-'));
  try {
    const dir = path.join(root, '.prereview');
    fs.mkdirSync(dir);
    const occupied = path.join(dir, 'main...feature-foo.json');
    fs.writeFileSync(occupied, '{');
    await assert.rejects(reviewFilePath(root, 'main', 'feature-foo'), /main\.\.\.feature-foo\.json can't be read/);
    fs.writeFileSync(occupied, '{ "base": "main", "target": "feature-foo", "threads": [ }');
    assert.strictEqual(path.basename(await reviewFilePath(root, 'main', 'feature-foo')), 'main...feature-foo.json');
    fs.writeFileSync(occupied, JSON.stringify({ base: 'main', target: 'feature/foo' }));
    assert.strictEqual(path.basename(await reviewFilePath(root, 'main', 'feature-foo')), 'main...feature-foo-2.json');
    assert.strictEqual(path.basename(await reviewFilePath(root, 'main', 'feature/foo')), 'main...feature-foo.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readPair finds what a review compares in a file that is not valid JSON', () => {
  assert.deepStrictEqual(readPair('{"base": "main", "target": "feat/\\"x\\"", "threads": [,]}'), { base: 'main', target: 'feat/"x"' });
  assert.deepStrictEqual(readPair('{"base": "origin/main", "target": null, oops'), { base: 'origin/main', target: null });
  assert.strictEqual(readPair('{"title": "x"'), undefined);
});

test('ReviewDocument writes back what it does not understand and keeps ids stable', () => {
  const text = JSON.stringify({
    base: 'main',
    target: null,
    extra: { kept: true },
    threads: [
      { file: 'a.ts', startLine: 2, resolved: false, note: 'agent field', comments: [{ author: 'agent', text: 'aliased' }, { author: 'agent', emoji: '+1' }] },
      { id: 'gone', comments: [] },
      { id: 'abs', file: '/repo/wt/src/b.ts', startLine: 1, comments: [{ author: 'agent', body: 'absolute' }] },
    ],
  });
  const doc = new ReviewDocument(text, { roots: ['/repo/wt', '/repo'] });
  const [first, abs] = doc.data.threads;
  assert.deepStrictEqual([first.comments.map((c) => c.body), first.unreadable, doc.data.unreadable], [['aliased'], 1, 1]);
  assert.deepStrictEqual([abs.file, abs.startLine], ['src/b.ts', 1]);
  doc.addComment(first.id, { id: 'c1', author: REVIEWER, body: 'reply' });
  const written = JSON.parse(doc.toString());
  assert.deepStrictEqual(Object.keys(written), ['agentInstructions', 'title', 'description', 'base', 'target', 'threads', 'extra']);
  assert.deepStrictEqual(written.extra, { kept: true });
  assert.deepStrictEqual(written.threads[0], {
    id: first.id,
    file: 'a.ts',
    startLine: 2,
    resolved: false,
    note: 'agent field',
    comments: [{ id: first.comments[0].id, author: 'agent', body: 'aliased' }, { author: 'agent', emoji: '+1' }, { id: 'c1', author: REVIEWER, body: 'reply' }],
  });
  assert.deepStrictEqual(written.threads[1], { id: 'gone', comments: [] });
  assert.strictEqual(written.threads[2].file, 'src/b.ts');
  // Ids read back the same, so a later edit finds the same comment
  assert.deepStrictEqual(parseReview(doc.toString()).threads[0].comments.map((c) => c.id), [first.comments[0].id, 'c1']);
});

test('ReviewDocument edits and deletes comments by id', () => {
  const text = JSON.stringify({
    base: 'main',
    threads: [{ id: 't', resolved: false, comments: [{ id: 'a', author: REVIEWER, body: 'one' }, { id: 'b', author: 'agent', body: 'two' }] }],
  });
  const doc = new ReviewDocument(text);
  doc.deleteComment('t', 'a');
  assert.throws(() => doc.editComment('t', 'a', 'x'), /no longer in the review file/);
  doc.editComment('t', 'b', 'changed');
  assert.deepStrictEqual(parseReview(doc.toString()).threads[0].comments.map((c) => [c.id, c.body]), [['b', 'changed']]);
  doc.deleteComment('t', 'b');
  assert.deepStrictEqual(parseReview(doc.toString()).threads, []);
});

test('follow keeps a span above a change and shifts one below it', () => {
  const before = ['a', 'b', 'c', 'd', 'e'];
  assert.deepStrictEqual(follow(before, ['a', 'b', 'c', 'd', 'E', 'f'], { start: 2, end: 3 }), { start: 2, end: 3, lost: false });
  assert.deepStrictEqual(follow(before, ['c', 'd', 'e'], { start: 4, end: 4 }), { start: 2, end: 2, lost: false });
  assert.deepStrictEqual(follow(before, ['x', 'y', 'a', 'b', 'c', 'd', 'e'], { start: 5, end: 5 }), { start: 7, end: 7, lost: false });
});

test('follow tells identical lines apart by their neighbours', () => {
  const before = ['function f(a) {', '  if (a) {', '    return 1;', '  }', '  return 2;', '}'];
  // A guard with its own closing brace goes in above the commented one, and the function gets a new first line
  const after = ['function f(a) {', '  log(a);', '  if (!a) {', '    throw new Error();', '  }', '  if (a) {', '    return 1;', '  }', '  return 3;', '}'];
  assert.deepStrictEqual(follow(before, after, { start: 4, end: 4 }), { start: 8, end: 8, lost: false });
});

test('follow marks a span whose lines changed as lost, and finds them again when they come back', () => {
  const before = ['a', 'b', 'c'];
  assert.deepStrictEqual(follow(before, ['a', 'B', 'c'], { start: 2, end: 2 }, ['b']), { start: 2, end: 2, lost: true });
  // An outdated thread follows the lines it is on now, and its own code when it reappears
  assert.deepStrictEqual(follow(['a', 'B', 'c'], ['x', 'a', 'B', 'c'], { start: 2, end: 2 }, ['b']), { start: 3, end: 3, lost: false });
  assert.deepStrictEqual(follow(['a', 'B', 'c'], ['a', 'b', 'c'], { start: 2, end: 2 }, ['b']), { start: 2, end: 2, lost: false });
});

test('fileError points at where a review file stops being valid JSON', () => {
  const at = (text: string) => {
    try {
      parseReview(text);
    } catch (e) {
      const { line, column } = fileError(e as Error, text);
      return [line, column];
    }
  };
  assert.deepStrictEqual(at('{\n  "base": "main",\n  "threads": [\n  }\n}'), [4, 3]);
  assert.deepStrictEqual(at('{"base": "main",}'), [1, 17]);
  assert.deepStrictEqual(at('{"base": "a\nb"}'), [1, 12]);
  assert.deepStrictEqual(at('{"base": "main", "threads": ['), [1, 30]);
  assert.deepStrictEqual(fileError(new Error('missing "base"'), '{}'), { message: 'missing "base"' });
});

test('follow keeps a thread on its own code when one write changes several places', () => {
  const before = ['function f(a) {', '  if (a) {', '    return 1;', '  }', '  return 2;', '}', 'function g() {', '  if (x) {', '    return 3;', '  }', '}'];
  // The commented brace goes away with its if, and g changes too: the thread stays in f, outdated
  const after = ['function f(a) {', '  return a ? 1 : 2;', '}', 'function g() {', '  if (x) {', '    return 4;', '  }', '}'];
  assert.deepStrictEqual(follow(before, after, { start: 4, end: 4 }, ['  }']), { start: 2, end: 2, lost: true });
  // Imports added above and the commented line itself changed: outdated, where the line is now
  const code = ['import a', '', 'const x = 1;', 'use(x);', 'end()'];
  const changed = ['import a', 'import b', 'import c', '', 'const x = 1;', 'use(x, 2);', 'end()'];
  assert.deepStrictEqual(follow(code, changed, { start: 4, end: 4 }, ['use(x);']), { start: 6, end: 6, lost: true });
});

test('follow finds code that moved elsewhere in the file', () => {
  const before = ['a();', 'function x() {', '  return 1;', '}', 'b();'];
  const after = ['a();', 'b();', '', 'function x() {', '  return 1;', '}'];
  assert.deepStrictEqual(follow(before, after, { start: 3, end: 3 }, ['  return 1;']), { start: 5, end: 5, lost: false });
});

test('reviewMarkdown writes a review out with the lines its threads are on', () => {
  const data = parseReview(
    JSON.stringify({
      title: 'Add caching',
      description: 'Caches results.',
      base: 'main',
      target: 'feat',
      threads: [
        { id: 'a', file: 'src/a.ts', startLine: 3, endLine: 4, snippet: 'x()\ny()', resolved: true, comments: [{ author: REVIEWER, body: 'Why?' }, { author: 'agent', body: '```ts\nz()\n```\nFaster.' }] },
        { id: 'b', comments: [{ author: REVIEWER, body: 'Add tests.' }] },
      ],
    }),
  );
  assert.strictEqual(
    reviewMarkdown(data, (t) => (t.id === 'a' ? { start: 5, end: 6 } : undefined)),
    [
      '# Add caching',
      '',
      'main ↔ feat',
      '',
      'Caches results.',
      '',
      '## `src/a.ts:5-6` · Resolved',
      '',
      '```ts',
      'x()',
      'y()',
      '```',
      '',
      '**You:**',
      '',
      'Why?',
      '',
      '**Agent:**',
      '',
      '```ts',
      'z()',
      '```',
      'Faster.',
      '',
      '## General comment · Awaiting agent',
      '',
      '**You:**',
      '',
      'Add tests.',
      '',
    ].join('\n'),
  );
});
