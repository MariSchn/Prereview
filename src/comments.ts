import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { Comment, Thread } from './model';
import { Review } from './review';

const REVIEWER = 'reviewer';

export class ReviewComment implements vscode.Comment {
  readonly body: vscode.MarkdownString;
  readonly mode = vscode.CommentMode.Preview;
  readonly author: vscode.CommentAuthorInformation;
  readonly timestamp?: Date;

  constructor(comment: Comment, readonly threadId: string, readonly index: number) {
    this.body = new vscode.MarkdownString(comment.body);
    this.author = { name: comment.author === REVIEWER ? 'You' : comment.author || 'agent' };
    const time = Date.parse(comment.createdAt ?? '');
    if (!isNaN(time)) this.timestamp = new Date(time);
  }
}

export class CommentsController implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('prereview', 'Prereview');
  private readonly threads = new Map<string, vscode.CommentThread>();
  private review?: Review;

  constructor() {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        this.review?.pathOf(doc.uri) === undefined ? [] : [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)],
    };
  }

  setReview(review: Review | undefined): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    this.review = review;
    this.render();
  }

  render(): void {
    const review = this.review;
    if (!review) return;
    const seen = new Set<string>();
    for (const t of review.data.threads) {
      seen.add(t.id);
      const uri = review.rightUri(t.file);
      const pos = review.position(t);
      const range = new vscode.Range(Math.max(pos.start - 1, 0), 0, Math.max(pos.end - 1, 0), 0);
      let thread = this.threads.get(t.id);
      if (thread && thread.uri.toString() !== uri.toString()) {
        thread.dispose();
        thread = undefined;
      }
      if (!thread) {
        thread = this.controller.createCommentThread(uri, range, []);
        thread.collapsibleState = t.resolved
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
        this.threads.set(t.id, thread);
      }
      thread.range = range;
      thread.comments = t.comments.map((c, i) => new ReviewComment(c, t.id, i));
      thread.contextValue = t.resolved ? 'resolved' : 'unresolved';
      thread.state = t.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.label = pos.outdated ? 'Outdated' : undefined;
    }
    for (const [id, thread] of this.threads) {
      if (!seen.has(id)) {
        thread.dispose();
        this.threads.delete(id);
      }
    }
  }

  async createThread(reply: vscode.CommentReply): Promise<void> {
    const draft = reply.thread;
    const review = this.review;
    const file = review?.pathOf(draft.uri);
    if (!review || file === undefined) {
      draft.dispose();
      return;
    }
    const doc = await vscode.workspace.openTextDocument(draft.uri);
    const start = draft.range.start.line;
    const end = draft.range.end.line;
    const snippet = Array.from({ length: end - start + 1 }, (_, k) => doc.lineAt(start + k).text).join('\n');
    await review.update((data) =>
      data.threads.push({
        id: randomUUID().slice(0, 8),
        file,
        startLine: start + 1,
        endLine: end + 1,
        snippet,
        resolved: false,
        comments: [newComment(reply.text)],
      }),
    );
    draft.dispose();
  }

  async reply(reply: vscode.CommentReply): Promise<void> {
    await this.updateThread(reply.thread, (t) => t.comments.push(newComment(reply.text)));
  }

  async setResolved(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    await this.updateThread(thread, (t) => (t.resolved = resolved));
    thread.collapsibleState = resolved
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
  }

  async deleteComment(comment: ReviewComment): Promise<void> {
    await this.review?.update((data) => {
      const t = data.threads.find((t) => t.id === comment.threadId);
      if (!t) return;
      t.comments.splice(comment.index, 1);
      if (!t.comments.length) data.threads.splice(data.threads.indexOf(t), 1);
    });
  }

  dispose(): void {
    this.controller.dispose();
  }

  private async updateThread(thread: vscode.CommentThread, fn: (t: Thread) => void) {
    const id = [...this.threads].find(([, t]) => t === thread)?.[0];
    if (!id) return;
    await this.review?.update((data) => {
      const t = data.threads.find((t) => t.id === id);
      if (t) fn(t);
    });
  }
}

function newComment(body: string): Comment {
  return { author: REVIEWER, body, createdAt: new Date().toISOString() };
}
