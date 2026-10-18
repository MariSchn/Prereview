import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile, catBlob, changedFiles, hashObjects, mergeBase, revParse, show, worktrees } from './git';
import { REVIEWER, ReviewData, Thread, locate, newId, parseReview, reviewFileName, serializeReview } from './model';

export const SCHEME = 'prereview';
const DELETED = 'deleted';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, file, ref, blob } = JSON.parse(uri.query);
    try {
      if (blob) return await catBlob(root, blob);
      if (ref) return await show(root, ref, file);
      return '';
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

function isInside(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function writeReview(filePath: string, data: ReviewData): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.gitignore'), '*\n');
  await fs.writeFile(filePath, serializeReview(data));
}

function viewedKey(filePath: string): string {
  return `prereview.viewed:${filePath}`;
}

export async function deleteReview(filePath: string, state: vscode.Memento): Promise<void> {
  await fs.rm(filePath, { force: true });
  await state.update(viewedKey(filePath), undefined);
}

export type Side = 'head' | 'base';

export interface Location {
  file: string;
  side: Side;
}

export interface Position {
  start: number;
  end: number;
  outdated: boolean;
}

export type ViewState = 'viewed' | 'updated' | 'unviewed';

export interface ReviewChange {
  external: boolean;
}

export class Review implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ReviewChange>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private targetWatcher?: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private lastWarning?: string;
  private baseSha = '';
  private targetSha?: string;
  private positions = new Map<string, Position>();
  private sources = new Map<string, string[] | undefined>();
  private blobs = new Map<string, string>();
  files: ChangedFile[] = [];
  targetDir?: string;

  private constructor(
    readonly root: string,
    readonly filePath: string,
    public data: ReviewData,
    private readonly state: vscode.Memento,
  ) {
    this.watcher = this.watch(root);
  }

  static async open(root: string, base: string, target: string | null, state: vscode.Memento): Promise<Review> {
    const filePath = path.join(root, '.prereview', reviewFileName(base, target));
    try {
      await fs.access(filePath);
    } catch {
      await writeReview(filePath, { title: '', description: '', base, target, threads: [] });
    }
    return Review.load(filePath, state);
  }

  static async load(filePath: string, state: vscode.Memento): Promise<Review> {
    const data = parseReview(await fs.readFile(filePath, 'utf8'));
    const review = new Review(path.dirname(path.dirname(filePath)), filePath, data, state);
    await review.refresh();
    return review;
  }

  get targetLabel(): string {
    return this.data.target ?? 'working tree';
  }

  get title(): string {
    return `${this.data.base} ↔ ${this.targetLabel}`;
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
      try {
        await this.loadChanges();
      } catch (e) {
        ok = false;
        this.warn((e as Error).message);
        this.files = [];
      }
      if (ok) this.lastWarning = undefined;
      await this.reanchor();
      this.changed.fire({ external: true });
    });
  }

  addThread(location: { file?: string; side?: 'base'; startLine?: number; endLine?: number }, body: string): Promise<void> {
    return this.update((data) => data.threads.push({ id: newId(), ...location, resolved: false, comments: [newComment(body)] }));
  }

  reply(id: string, body: string): Promise<void> {
    return this.updateThread(id, (t) => t.comments.push(newComment(body)));
  }

  setResolved(id: string, resolved: boolean): Promise<void> {
    return this.updateThread(id, (t) => (t.resolved = resolved));
  }

  editComment(id: string, index: number, body: string): Promise<void> {
    return this.updateThread(id, (t) => {
      if (t.comments[index]) t.comments[index].body = body;
    });
  }

  deleteComment(id: string, index: number): Promise<void> {
    return this.updateThread(id, (t, data) => {
      t.comments.splice(index, 1);
      if (!t.comments.length) data.threads.splice(data.threads.indexOf(t), 1);
    });
  }

  position(thread: Thread): Position | undefined {
    if (thread.startLine === undefined) return undefined;
    return this.positions.get(thread.id) ?? { start: thread.startLine, end: thread.endLine ?? thread.startLine, outdated: true };
  }

  source(thread: Thread): string[] | undefined {
    return thread.file ? this.sources.get(sourceKey(thread.file, thread.side)) : undefined;
  }

  headUri(file: string): vscode.Uri {
    return this.targetDir ? vscode.Uri.file(path.join(this.targetDir, file)) : this.gitUri(file, { ref: this.data.target! });
  }

  baseUri(file: string): vscode.Uri {
    return this.gitUri(this.oldPath(file), { ref: this.baseSha });
  }

  threadUri(thread: Thread): vscode.Uri | undefined {
    if (!thread.file) return undefined;
    return thread.side === 'base' ? this.baseUri(thread.file) : this.headUri(thread.file);
  }

  diffUris(file: ChangedFile): [vscode.Uri, vscode.Uri] {
    const left = file.status === 'A' ? this.gitUri(file.path) : this.baseUri(file.path);
    const right = file.status === 'D' ? this.gitUri(file.path) : this.headUri(file.path);
    return [left, right];
  }

  sinceViewedUris(file: ChangedFile): [vscode.Uri, vscode.Uri] | undefined {
    const seen = this.viewed()[file.path];
    if (!seen) return undefined;
    const left = seen === DELETED ? this.gitUri(file.path) : this.gitUri(file.path, { blob: seen });
    return [left, this.diffUris(file)[1]];
  }

  locationOf(uri: vscode.Uri): Location | undefined {
    if (uri.scheme === SCHEME) {
      const { ref, file } = JSON.parse(uri.query);
      if (ref && ref === this.baseSha) {
        const f = this.files.find((f) => f.oldPath === file && f.status !== 'A');
        return f && { file: f.path, side: 'base' };
      }
      if (ref && !this.targetDir && ref === this.data.target) {
        const f = this.files.find((f) => f.path === file && f.status !== 'D');
        return f && { file: f.path, side: 'head' };
      }
    } else if (uri.scheme === 'file' && this.targetDir) {
      const file = path.relative(this.targetDir, uri.fsPath).split(path.sep).join('/');
      const f = this.files.find((f) => f.path === file && f.status !== 'D');
      return f && { file: f.path, side: 'head' };
    }
    return undefined;
  }

  viewState(file: ChangedFile): ViewState {
    const seen = this.viewed()[file.path];
    if (!seen) return 'unviewed';
    return this.blobs.get(file.path) === seen ? 'viewed' : 'updated';
  }

  setViewed(file: ChangedFile, viewed: boolean): Promise<void> {
    return this.enqueue(async () => {
      const all = { ...this.viewed() };
      if (viewed) {
        const blob = await this.blobOf(file, true);
        if (!blob) return;
        all[file.path] = blob;
        this.blobs.set(file.path, blob);
      } else {
        delete all[file.path];
      }
      await this.state.update(this.viewedKey, all);
      this.changed.fire({ external: false });
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher.dispose();
    this.targetWatcher?.dispose();
    this.changed.dispose();
  }

  private gitUri(file: string, query: { ref?: string; blob?: string } = {}): vscode.Uri {
    const fsPath = vscode.Uri.file(path.join(this.targetDir ?? this.root, file)).path;
    return vscode.Uri.from({ scheme: SCHEME, path: fsPath, query: JSON.stringify({ root: this.root, file, ...query }) });
  }

  private get viewedKey(): string {
    return viewedKey(this.filePath);
  }

  private viewed(): Record<string, string> {
    return this.state.get<Record<string, string>>(this.viewedKey) ?? {};
  }

  private async blobOf(file: ChangedFile, write: boolean): Promise<string | undefined> {
    if (file.status === 'D') return DELETED;
    if (!this.targetDir) return file.blob;
    return (await hashObjects(this.targetDir, [file.path], write))[0];
  }

  private async loadChanges(): Promise<void> {
    const { base, target } = this.data;
    const targetSha = target ? await revParse(this.root, target) : undefined;
    const targetDir = target ? (await worktrees(this.root)).get(target) : this.root;
    if (targetSha !== this.targetSha) contentProvider.refreshOpen();
    this.targetSha = targetSha;
    this.baseSha = await mergeBase(this.root, base, targetSha ?? 'HEAD');
    this.files = (await changedFiles(this.root, this.baseSha, { ref: targetDir ? undefined : targetSha, dir: targetDir })).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    if (targetDir !== this.targetDir) {
      this.targetDir = targetDir;
      this.targetWatcher?.dispose();
      this.targetWatcher = targetDir && !isInside(targetDir, this.root) ? this.watch(targetDir) : undefined;
    }
    const viewed = this.viewed();
    const tracked = this.files.filter((f) => viewed[f.path]);
    const blobs = new Map<string, string>();
    if (this.targetDir) {
      const present = tracked.filter((f) => f.status !== 'D');
      const shas = await hashObjects(this.targetDir, present.map((f) => f.path), false);
      present.forEach((f, i) => blobs.set(f.path, shas[i]));
    }
    for (const f of tracked) {
      if (f.status === 'D') blobs.set(f.path, DELETED);
      else if (!this.targetDir && f.blob) blobs.set(f.path, f.blob);
    }
    this.blobs = blobs;
  }

  private update(fn: (data: ReviewData) => void): Promise<void> {
    return this.enqueue(async () => {
      const data = parseReview(await fs.readFile(this.filePath, 'utf8'));
      fn(data);
      for (const t of data.threads) {
        if (!t.file || t.startLine === undefined || t.snippet !== undefined) continue;
        const lines = await this.lines(t.file, t.side);
        if (lines) t.snippet = lines.slice(t.startLine - 1, t.endLine).join('\n');
      }
      await writeReview(this.filePath, data);
      this.data = data;
      await this.reanchor();
      this.changed.fire({ external: false });
    });
  }

  private updateThread(id: string, fn: (t: Thread, data: ReviewData) => void): Promise<void> {
    return this.update((data) => {
      const t = data.threads.find((t) => t.id === id);
      if (t) fn(t, data);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private watch(dir: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '**/*'));
    const schedule = () => this.scheduleRefresh();
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
    return watcher;
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 300);
  }

  private async reanchor(): Promise<void> {
    const positions = new Map<string, Position>();
    const sources = new Map<string, string[] | undefined>();
    for (const t of this.data.threads) {
      if (!t.file || t.startLine === undefined) continue;
      const end = t.endLine ?? t.startLine;
      const key = sourceKey(t.file, t.side);
      if (!sources.has(key)) sources.set(key, await this.lines(t.file, t.side));
      const lines = sources.get(key);
      const loc = lines && (t.snippet === undefined ? { start: t.startLine, end } : locate(lines, t.snippet, t.startLine));
      positions.set(t.id, loc ? { ...loc, outdated: false } : { start: t.startLine, end, outdated: true });
    }
    this.positions = positions;
    this.sources = sources;
  }

  private async lines(file: string, side?: 'base'): Promise<string[] | undefined> {
    try {
      let text: string;
      if (side === 'base') {
        text = await show(this.root, this.baseSha, this.oldPath(file));
      } else if (this.targetDir) {
        const fsPath = path.join(this.targetDir, file);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
        text = doc?.isDirty ? doc.getText() : await fs.readFile(fsPath, 'utf8');
      } else {
        text = await show(this.root, this.data.target!, file);
      }
      return text.split(/\r?\n/);
    } catch {
      return undefined;
    }
  }

  private oldPath(file: string): string {
    return this.files.find((f) => f.path === file)?.oldPath ?? file;
  }

  private warn(message: string): void {
    if (message !== this.lastWarning) vscode.window.showWarningMessage(`Prereview: ${message}`);
    this.lastWarning = message;
  }
}

function sourceKey(file: string, side?: 'base'): string {
  return `${side ?? 'head'}:${file}`;
}

function newComment(body: string) {
  return { author: REVIEWER, body, createdAt: new Date().toISOString() };
}
