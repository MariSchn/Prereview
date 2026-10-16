import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile, changedFiles, mergeBase, revParse, show } from './git';
import { ReviewData, Thread, locate, parseReview, reviewFileName, serializeReview } from './model';

export const SCHEME = 'prereview';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref } = JSON.parse(uri.query);
    if (!ref) return '';
    try {
      return await show(root, ref, uri.path.slice(1));
    } catch {
      return '';
    }
  }

  refreshOpen(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === SCHEME) this.changed.fire(doc.uri);
    }
  }
}

export const contentProvider = new GitContentProvider();

function gitUri(root: string, ref: string, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + file, query: JSON.stringify({ root, ref }) });
}

async function writeReview(filePath: string, data: ReviewData): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.gitignore'), '*\n');
  await fs.writeFile(filePath, serializeReview(data));
}

export interface Position {
  start: number;
  end: number;
  outdated: boolean;
}

export class Review implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private lastWarning?: string;
  private baseSha = '';
  private targetSha?: string;
  private positions = new Map<string, Position>();
  files: ChangedFile[] = [];

  private constructor(readonly root: string, readonly filePath: string, public data: ReviewData) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    const schedule = () => this.scheduleRefresh();
    this.watcher.onDidChange(schedule);
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidDelete(schedule);
  }

  static async open(root: string, base: string, target: string | null): Promise<Review> {
    const filePath = path.join(root, '.prereview', reviewFileName(base, target));
    try {
      await fs.access(filePath);
    } catch {
      await writeReview(filePath, { base, target, threads: [] });
    }
    return Review.load(filePath);
  }

  static async load(filePath: string): Promise<Review> {
    const data = parseReview(await fs.readFile(filePath, 'utf8'));
    const review = new Review(path.dirname(path.dirname(filePath)), filePath, data);
    await review.refresh();
    return review;
  }

  get title(): string {
    return `${this.data.base} ↔ ${this.data.target ?? 'working tree'}`;
  }

  refresh(): Promise<void> {
    return this.enqueue(async () => {
      let ok = true;
      try {
        this.data = parseReview(await fs.readFile(this.filePath, 'utf8'));
      } catch (e) {
        ok = false;
        this.warn(`Could not read ${path.basename(this.filePath)}: ${(e as Error).message}`);
      }
      const { base, target } = this.data;
      try {
        const targetSha = target ? await revParse(this.root, target) : undefined;
        if (targetSha !== this.targetSha) contentProvider.refreshOpen();
        this.targetSha = targetSha;
        this.baseSha = await mergeBase(this.root, base, targetSha ?? 'HEAD');
        this.files = (await changedFiles(this.root, this.baseSha, targetSha)).sort((a, b) => a.path.localeCompare(b.path));
      } catch (e) {
        ok = false;
        this.warn((e as Error).message);
        this.files = [];
      }
      if (ok) this.lastWarning = undefined;
      await this.reanchor();
      this.changed.fire();
    });
  }

  update(fn: (data: ReviewData) => void): Promise<void> {
    return this.enqueue(async () => {
      const data = parseReview(await fs.readFile(this.filePath, 'utf8'));
      fn(data);
      await writeReview(this.filePath, data);
      this.data = data;
      await this.reanchor();
      this.changed.fire();
    });
  }

  position(thread: Thread): Position {
    return this.positions.get(thread.id) ?? { start: thread.startLine, end: thread.endLine, outdated: true };
  }

  rightUri(file: string): vscode.Uri {
    return this.data.target ? gitUri(this.root, this.data.target, file) : vscode.Uri.file(path.join(this.root, file));
  }

  diffUris(file: ChangedFile): [vscode.Uri, vscode.Uri] {
    const left = file.status === 'A' ? gitUri(this.root, '', file.path) : gitUri(this.root, this.baseSha, file.oldPath);
    const right = file.status === 'D' ? gitUri(this.root, '', file.path) : this.rightUri(file.path);
    return [left, right];
  }

  pathOf(uri: vscode.Uri): string | undefined {
    let file: string;
    if (this.data.target) {
      if (uri.scheme !== SCHEME || JSON.parse(uri.query).ref !== this.data.target) return undefined;
      file = uri.path.slice(1);
    } else {
      if (uri.scheme !== 'file') return undefined;
      file = path.relative(this.root, uri.fsPath).split(path.sep).join('/');
    }
    return this.files.some((f) => f.path === file && f.status !== 'D') ? file : undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher.dispose();
    this.changed.dispose();
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 300);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async reanchor(): Promise<void> {
    const positions = new Map<string, Position>();
    const cache = new Map<string, string[] | undefined>();
    for (const t of this.data.threads) {
      if (!cache.has(t.file)) cache.set(t.file, await this.lines(t.file));
      const lines = cache.get(t.file);
      const loc = lines && locate(lines, t.snippet, t.startLine);
      positions.set(t.id, loc ? { ...loc, outdated: false } : { start: t.startLine, end: t.endLine, outdated: true });
    }
    this.positions = positions;
  }

  private async lines(file: string): Promise<string[] | undefined> {
    try {
      let text: string;
      if (this.data.target) {
        text = await show(this.root, this.data.target, file);
      } else {
        const fsPath = path.join(this.root, file);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
        text = doc?.isDirty ? doc.getText() : await fs.readFile(fsPath, 'utf8');
      }
      return text.split(/\r?\n/);
    } catch {
      return undefined;
    }
  }

  private warn(message: string): void {
    if (message !== this.lastWarning) vscode.window.showWarningMessage(`Prereview: ${message}`);
    this.lastWarning = message;
  }
}
