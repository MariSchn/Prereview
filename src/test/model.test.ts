import * as assert from 'assert';
import { test } from 'node:test';
import { locate, parseReview, reviewFileName, serializeReview } from '../model';

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

test('parseReview drops malformed threads and fills defaults', () => {
  const data = parseReview(
    JSON.stringify({
      base: 'main',
      threads: [
        { id: 't1', file: 'a.ts', startLine: 3, comments: [{ body: 'hi' }, { nope: 1 }] },
        { file: 'b.ts', startLine: 1, comments: [] },
      ],
    }),
  );
  assert.strictEqual(data.target, null);
  assert.deepStrictEqual(data.threads, [
    { id: 't1', file: 'a.ts', startLine: 3, endLine: 3, snippet: '', resolved: false, comments: [{ author: 'agent', body: 'hi', createdAt: undefined }] },
  ]);
});

test('serializeReview round-trips and includes agent instructions', () => {
  const data = { base: 'main', target: 'feat/x', threads: [] };
  const text = serializeReview(data);
  assert.ok(JSON.parse(text).agentInstructions);
  assert.deepStrictEqual(parseReview(text), data);
});

test('reviewFileName is filesystem safe', () => {
  assert.strictEqual(reviewFileName('origin/main', 'feat/x'), 'origin-main...feat-x.json');
  assert.strictEqual(reviewFileName('main', null), 'main...worktree.json');
});
