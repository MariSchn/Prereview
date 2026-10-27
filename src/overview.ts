import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildTree, flatten } from './fileTree';
import { REVIEWER, Thread, ThreadStatus, authorName, describeFileError, threadStatus } from './model';
import { Position, Review } from './review';

interface CommentView {
  id: string;
  author: string;
  mine: boolean;
  time?: string;
  html: string;
  body?: string;
}

interface ThreadView {
  id: string;
  status: ThreadStatus;
  file?: string;
  where: string;
  outdated: boolean;
  base: boolean;
  snippet?: { start: number; focus: [number, number]; lines: string[] };
  comments: CommentView[];
  unreadable?: number;
}

const COMMANDS = ['openAllChanges', 'openAllSinceViewed', 'finishReview', 'refresh'];
const CONTEXT = 2;

export async function confirmDelete(): Promise<boolean> {
  return (await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete')) === 'Delete';
}

export class Overview implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private review?: Review;
  private version = 0;
  // The state the page shows; posting it again would only rebuild the page
  private posted?: string;
  private rendered = new Map<string, string>();
  private stale = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly openThread: (thread: Thread) => Thenable<unknown>,
  ) {}

  setReview(review: Review | undefined): void {
    this.review = review;
    if (review) void this.update();
    else this.panel?.dispose();
  }

  get visible(): boolean {
    return !!this.panel?.visible;
  }

  show(): void {
    if (!this.review) return;
    if (this.panel) return this.panel.reveal();
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('prereview.overview', 'Review', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = this.icon(false);
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('overview.css')}">
<title>Review</title>
</head>
<body>
<main id="app"></main>
<script nonce="${nonce}" src="${asset('overview.js')}"></script>
</body>
</html>`;
    webview.onDidReceiveMessage((message) =>
      this.handle(message).catch((e) => vscode.window.showErrorMessage(`Prereview: ${(e as Error).message}`)),
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.posted = undefined;
    });
  }

  async update(): Promise<void> {
    const version = ++this.version;
    if (!this.panel || !this.review) return;
    const state = await this.state(this.review);
    if (version !== this.version || !this.panel) return;
    this.panel.title = `Review: ${state.title}`;
    this.panel.iconPath = this.icon(state.counts.awaitingYou > 0);
    const posted = JSON.stringify(state);
    if (posted === this.posted) return;
    this.posted = posted;
    await this.panel.webview.postMessage({ type: 'state', state });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async handle(message: any): Promise<void> {
    const review = this.review;
    if (!review || typeof message?.type !== 'string') return;
    const body = typeof message.body === 'string' ? message.body.trim() : '';
    switch (message.type) {
      case 'ready':
        this.posted = undefined;
        return this.update();
      case 'open': {
        const thread = review.data.threads.find((t) => t.id === message.id);
        if (thread) await this.openThread(thread);
        return;
      }
      case 'reply':
        if (body) await review.reply(message.id, body, message.resolve === true);
        return;
      case 'resolve':
        return review.setResolved(message.id, message.resolved === true);
      case 'comment':
        if (body) await review.addThread({}, body);
        return;
      case 'edit':
        if (body) await review.editComment(message.id, message.commentId, body);
        return;
      case 'delete':
        if (await confirmDelete()) await review.deleteComment(message.id, message.commentId);
        return;
      case 'command':
        if (COMMANDS.includes(message.name)) await vscode.commands.executeCommand(`prereview.${message.name}`);
        return;
      case 'copyPath':
        await review.syncLines();
        return vscode.env.clipboard.writeText(review.filePath);
      case 'openReviewFile':
        return vscode.commands.executeCommand('prereview.openReviewFile');
      case 'openFile': {
        const file = review.files.find((f) => f.path === message.path);
        if (file) await vscode.commands.executeCommand('prereview.openDiff', file);
        return;
      }
      case 'sinceViewed': {
        const file = review.files.find((f) => f.path === message.path);
        if (file) await vscode.commands.executeCommand('prereview.openSinceViewed', file);
        return;
      }
      case 'viewed': {
        const file = review.files.find((f) => f.path === message.path);
        if (file) await review.setViewed([file], message.viewed === true);
        return;
      }
    }
  }

  private async state(review: Review) {
    const counts: Record<ThreadStatus, number> = { awaitingYou: 0, awaitingAgent: 0, resolved: 0 };
    const threads: ThreadView[] = [];
    this.stale = this.rendered;
    this.rendered = new Map();
    for (const t of review.data.threads) {
      const status = threadStatus(t);
      counts[status]++;
      const pos = review.position(t);
      let snippet: ThreadView['snippet'];
      if (pos && t.file && t.snippet !== undefined) {
        const source = pos.outdated ? undefined : review.source(t);
        const lines = source && pos.end <= source.length ? source : undefined;
        let start = pos.start;
        let end = pos.end;
        if (lines) {
          start = Math.max(1, start - CONTEXT);
          end = Math.min(lines.length, end + CONTEXT);
          while (start < pos.start && !lines[start - 1].trim()) start++;
          while (end > pos.end && !lines[end - 1].trim()) end--;
        }
        const code = lines ? lines.slice(start - 1, end).join('\n') : t.snippet;
        snippet = { start, focus: [pos.start, pos.end], lines: await this.highlight(t.file, code) };
      }
      threads.push({
        id: t.id,
        status,
        file: t.file,
        where: where(t, pos),
        outdated: !!pos?.outdated,
        base: t.side === 'base',
        snippet,
        comments: await Promise.all(
          t.comments.map(async (c) => ({
            id: c.id,
            author: authorName(c.author),
            mine: c.author === REVIEWER,
            time: c.createdAt,
            html: await this.markdown(c.body),
            body: c.author === REVIEWER ? c.body : undefined,
          })),
        ),
        unreadable: t.unreadable,
      });
    }
    const { data } = review;
    return {
      title: data.title || review.title,
      titleFromAgent: !!data.title,
      base: data.base,
      target: review.targetLabel,
      worktree: data.target && review.targetDir ? review.targetDir : undefined,
      files: flatten(buildTree(review.files)).map((f) => ({
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        added: f.added,
        deleted: f.deleted,
        viewed: review.viewState(f),
        open: review.data.threads.filter((t) => t.file === f.path && !t.resolved).length,
      })),
      added: review.files.reduce((n, f) => n + (f.added ?? 0), 0),
      deleted: review.files.reduce((n, f) => n + (f.deleted ?? 0), 0),
      counts,
      changesError: review.changesError,
      fileError: review.fileError && `${path.basename(review.filePath)} ${describeFileError(review.fileError)}.`,
      unreadable: data.unreadable,
      description: data.description ? await this.markdown(data.description) : undefined,
      threads,
    };
  }

  private icon(attention: boolean): { light: vscode.Uri; dark: vscode.Uri } {
    const uri = (theme: string) => vscode.Uri.joinPath(this.extensionUri, 'media', `icon${attention ? '-attention' : ''}-${theme}.svg`);
    return { light: uri('light'), dark: uri('dark') };
  }

  private async highlight(file: string, snippet: string): Promise<string[]> {
    const ext = path.posix.extname(file).slice(1) || path.posix.basename(file);
    const fence = '`'.repeat(Math.max(3, ...(snippet.match(/`+/g) ?? []).map((run) => run.length + 1)));
    const html = await this.markdown(`${fence}${ext.toLowerCase()}\n${snippet}\n${fence}`);
    const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1];
    return code === undefined ? snippet.split('\n').map(escapeHtml) : splitLines(code.replace(/\n$/, ''));
  }

  private async markdown(text: string): Promise<string> {
    let html = this.rendered.get(text) ?? this.stale.get(text);
    if (html === undefined) {
      const rendered = await Promise.resolve(vscode.commands.executeCommand<string | undefined>('markdown.api.render', text)).catch(
        () => undefined,
      );
      html = rendered ?? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    }
    this.rendered.set(text, html);
    return html;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function splitLines(html: string): string[] {
  const open: string[] = [];
  return html.split('\n').map((line) => {
    const prefix = open.join('');
    for (const [tag] of line.matchAll(/<\/?span[^>]*>/g)) {
      if (tag.startsWith('</')) open.pop();
      else open.push(tag);
    }
    return prefix + line + '</span>'.repeat(open.length);
  });
}

function where(thread: Thread, pos: Position | undefined): string {
  if (!thread.file) return '';
  const side = thread.side === 'base' ? 'old version, ' : '';
  if (!pos) return `${side}whole file`;
  return pos.start === pos.end ? `${side}line ${pos.start}` : `${side}lines ${pos.start}–${pos.end}`;
}
