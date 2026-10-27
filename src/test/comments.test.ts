import './stubVscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import * as fake from './fakeVscode';
import { CommentsController, ReviewComment } from '../comments';
import { git } from '../git';
import { Review } from '../review';

test('a review change redraws only the threads it changed, and an edit survives new replies', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-')));
  try {
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['config', 'user.email', 't@t']);
    await git(root, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'base']);
    fs.mkdirSync(path.join(root, '.prereview'));
    fs.writeFileSync(path.join(root, '.prereview', '.gitignore'), '*\n');
    fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\n');
    const review = await Review.open(root, 'main', null, new fake.Memento());
    await review.addThread({ file: 'a.ts', startLine: 1, endLine: 1 }, 'first');
    await review.addThread({ file: 'a.ts', startLine: 2, endLine: 2 }, 'second');
    const controller = new CommentsController(fake.Uri.file('/media') as any);
    controller.setReview(review);
    const [one, two] = fake.commentThreads.slice(-2);
    const before = [one.commentUpdates, two.commentUpdates];
    await review.reply(review.data.threads[0].id, 'more');
    controller.render();
    controller.render();
    assert.deepStrictEqual([one.commentUpdates, two.commentUpdates], [before[0] + 1, before[1]]);

    const editing: ReviewComment = one.comments[0];
    controller.editComment(editing);
    const data = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
    data.threads[0].comments.push({ author: 'agent', body: 'answer' });
    fs.writeFileSync(review.filePath, JSON.stringify(data));
    await review.refresh();
    controller.render();
    assert.strictEqual(one.comments[0], editing);
    assert.strictEqual(editing.mode, fake.CommentMode.Editing);
    assert.deepStrictEqual(one.comments.map((c: ReviewComment) => c.source.body), ['first', 'more', 'answer']);
    controller.cancelEdit(editing);
    assert.strictEqual(one.comments[0].mode, fake.CommentMode.Preview);
    controller.dispose();
    review.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
