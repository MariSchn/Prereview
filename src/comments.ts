import * as vscode from 'vscode';
import { Comment, REVIEWER, STATUS_LABELS, authorName, threadStatus } from './model';
import { Review } from './review';

export interface AuthorIcons {
  reviewer: vscode.Uri;
  agent: vscode.Uri;
}

function authorIcons(media: vscode.Uri): AuthorIcons {
  const kind = vscode.window.activeColorTheme.kind;
  const variant = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
  return {
    reviewer: vscode.Uri.joinPath(media, `reviewer-${variant}.svg`),
    agent: vscode.Uri.joinPath(media, `agent-${variant}.svg`),
  };
}

export class ReviewComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  readonly author: vscode.CommentAuthorInformation;
  readonly contextValue: string;
  readonly timestamp?: Date;

  constructor(comment: Comment, readonly threadId: string, readonly index: number, icons: AuthorIcons) {
    const mine = comment.author === REVIEWER;
    this.body = new vscode.MarkdownString(comment.body);
    this.author = { name: authorName(comment.author), iconPath: mine ? icons.reviewer : icons.agent };
    this.contextValue = mine ? 'reviewer' : 'agent';
    const time = Date.parse(comment.createdAt ?? '');
    if (!isNaN(time)) this.timestamp = new Date(time);
  }
}

export class CommentsController implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('prereview', 'Prereview');
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly selectionDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('prereview.commentRangeBackground'),
  });
  private readonly hintDecoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('prereview.collapsedThreadForeground'), margin: '0 0 0 2em' },
  });
  private readonly listeners: vscode.Disposable[];
  private review?: Review;
  private editing?: string;
  private icons: AuthorIcons;

  constructor(media: vscode.Uri) {
    this.icons = authorIcons(media);
    this.listeners = [
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.icons = authorIcons(media);
        this.render();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateThreads()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.decorateSelection(e.textEditor)),
    ];
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        this.review?.locationOf(doc.uri)
          ? { enableFileComments: true, ranges: [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)] }
          : undefined,
    };
  }

  setReview(review: Review | undefined): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    this.editing = undefined;
    this.review = review;
    this.render();
    if (!review) this.decorateThreads();
    for (const editor of vscode.window.visibleTextEditors) this.decorateSelection(editor);
  }

  render(): void {
    const review = this.review;
    if (!review) return;
    const seen = new Set<string>();
    for (const t of review.data.threads) {
      const uri = review.threadUri(t);
      if (!uri) continue;
      seen.add(t.id);
      const pos = review.position(t);
      const range = pos && new vscode.Range(Math.max(pos.start - 1, 0), 0, Math.max(pos.end - 1, 0), 0);
      const status = threadStatus(t);
      let thread = this.threads.get(t.id);
      if (thread && thread.uri.toString() !== uri.toString()) {
        thread.dispose();
        thread = undefined;
      }
      if (!thread) {
        // An undefined range makes a whole-file thread; it can only be set when the thread is created.
        thread = this.controller.createCommentThread(uri, range as vscode.Range, []);
        this.threads.set(t.id, thread);
      }
      if (range) thread.range = range;
      if (this.editing !== t.id) thread.comments = t.comments.map((c, i) => new ReviewComment(c, t.id, i, this.icons));
      const state = t.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      if (thread.state !== state) {
        thread.collapsibleState = t.resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
      }
      thread.state = state;
      thread.contextValue = t.resolved ? 'resolved' : 'unresolved';
      thread.label = [STATUS_LABELS[status], pos?.outdated ? 'Outdated' : ''].filter(Boolean).join(' · ');
    }
    for (const [id, thread] of this.threads) {
      if (!seen.has(id)) {
        thread.dispose();
        this.threads.delete(id);
      }
    }
    this.decorateThreads();
  }

  expandThread(id: string): void {
    // A thread's collapsed state is not reported back, so recreate it to be sure it opens.
    this.threads.get(id)?.dispose();
    this.threads.delete(id);
    this.render();
    const thread = this.threads.get(id);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  // Resolved threads start collapsed to a small gutter icon, so mark their line in the code too.
  private decorateThreads(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      const hints: vscode.DecorationOptions[] = [];
      for (const t of this.review?.data.threads ?? []) {
        const pos = t.resolved && this.review!.threadUri(t)?.toString() === uri ? this.review!.position(t) : undefined;
        if (!pos) continue;
        const hover = new vscode.MarkdownString(`[Show thread](command:prereview.expandThread?${encodeURIComponent(JSON.stringify([t.id]))})`);
        hover.isTrusted = { enabledCommands: ['prereview.expandThread'] };
        const line = Math.max(pos.start - 1, 0);
        hints.push({
          range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
          hoverMessage: hover,
          renderOptions: { after: { contentText: `Resolved thread · ${t.comments.length} comment${t.comments.length === 1 ? '' : 's'}` } },
        });
      }
      editor.setDecorations(this.hintDecoration, hints);
    }
  }

  // Comments cover whole lines, and the selection fades once the comment box takes focus.
  private decorateSelection(editor: vscode.TextEditor): void {
    const { selection } = editor;
    const show = this.review?.locationOf(editor.document.uri) && selection.start.line !== selection.end.line;
    editor.setDecorations(this.selectionDecoration, show ? [selection] : []);
  }

  async createThread(reply: vscode.CommentReply): Promise<void> {
    const draft = reply.thread;
    const location = this.review?.locationOf(draft.uri);
    if (!this.review || !location) {
      draft.dispose();
      return;
    }
    if (!reply.text.trim()) {
      draft.dispose();
      return;
    }
    const range = draft.range;
    await this.review.addThread(
      {
        file: location.file,
        side: location.side === 'base' ? 'base' : undefined,
        startLine: range && range.start.line + 1,
        endLine: range && range.end.line + 1,
      },
      reply.text,
    );
    draft.dispose();
  }

  async reply(reply: vscode.CommentReply, resolve = false): Promise<void> {
    const id = this.idOf(reply.thread);
    if (id && reply.text.trim()) await this.review?.reply(id, reply.text, resolve);
  }

  async setResolved(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    const id = this.idOf(thread);
    if (id) await this.review?.setResolved(id, resolved);
  }

  editComment(comment: ReviewComment): void {
    const thread = this.threads.get(comment.threadId);
    if (!thread) return;
    this.editing = comment.threadId;
    thread.comments = thread.comments.map((c) => {
      if (c === comment) c.mode = vscode.CommentMode.Editing;
      return c;
    });
  }

  async saveComment(comment: ReviewComment): Promise<void> {
    const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
    this.editing = undefined;
    await this.review?.editComment(comment.threadId, comment.index, body);
  }

  cancelEdit(): void {
    this.editing = undefined;
    this.render();
  }

  async deleteComment(comment: ReviewComment): Promise<void> {
    await this.review?.deleteComment(comment.threadId, comment.index);
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.selectionDecoration.dispose();
    this.hintDecoration.dispose();
    this.controller.dispose();
  }

  private idOf(thread: vscode.CommentThread): string | undefined {
    return [...this.threads].find(([, t]) => t === thread)?.[0];
  }
}
