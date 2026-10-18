import * as assert from 'assert';
import { test } from 'node:test';
import { REVIEWER, locate, parseReview, reviewFileName, serializeReview, threadStatus } from '../model';

test('locate keeps a thread whose snippet still matches', () => {
  assert.deepStrictEqual(locate(['a', 'b', 'c'], 'b', 2), { start: 2, end: 2 });
});

test('locate follows a snippet that moved to the nearest match', () => {
  const lines = ['x', 'foo', 'bar', 'y', 'y', 'y', 'foo', 'bar'];
  assert.deepStrictEqual(locate(lines, 'foo\nbar', 6), { start: 7, end: 8 });
  assert.deepStrictEqual(locate(lines, 'foo\nbar', 3), { start: 2, end: 3 });
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
  assert.deepStrictEqual(data.threads[0].comments, [{ author: 'agent', body: 'hi', createdAt: undefined }]);
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
  const thread = (authors: string[], resolved = false) => ({ id: 'x', resolved, comments: authors.map((author) => ({ author, body: '' })) });
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
