import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile, catBlob, changedFiles, hashObjects, mergeBase, revParse, show, worktrees } from './git';
import { REVIEWER, ReviewData, Thread, locate, newId, parseReview, reviewFilePath, serializeReview } from './model';

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
  private queuedRefresh?: Promise<void>;
  private refreshAgain = false;
  private warnings = new Set<string>();
  private disposed = false;
  private baseSha = '';
  private targetSha?: string;
  private positions = new Map<string, Position>();
  private sources = new Map<string, string[] | undefined>();
  private blobs = new Map<string, string>();
  private snapshot?: string;
  files: ChangedFile[] = [];
  changesError?: string;
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
    const filePath = await reviewFilePath(root, base, target);
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
    if (this.queuedRefresh) {
      this.refreshAgain = true;
      return this.queuedRefresh;
    }
    const next = this.enqueue(async () => {
      try {
        do {
          this.refreshAgain = false;
          await this.refreshOnce();
        } while (this.refreshAgain && !this.disposed);
      } finally {
        this.queuedRefresh = undefined;
      }
    });
    this.queuedRefresh = next;
    return next;
  }

  private async refreshOnce(): Promise<void> {
    if (this.disposed) return;
    const warnings: string[] = [];
    try {
      this.data = parseReview(await fs.readFile(this.filePath, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read ${path.basename(this.filePath)}: ${(e as Error).message}`);
    }
    try {
      await this.loadChanges();
    } catch (e) {
      warnings.push((e as Error).message);
      this.files = [];
      this.changesError = (e as Error).message;
    }
    if (this.disposed) return;
    for (const warning of warnings) {
      if (!this.warnings.has(warning)) vscode.window.showWarningMessage(`Prereview: ${warning}`);
    }
    this.warnings = new Set(warnings);
    await this.reanchor();
    // Unrelated file activity triggers refreshes too; redrawing the views each time makes them flicker.
    const snapshot = JSON.stringify([
      this.data,
      this.files,
      this.changesError,
      this.baseSha,
      this.targetSha,
      this.targetDir,
      [...this.blobs],
      [...this.positions],
    ]);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.changed.fire({ external: true });
  }

  async addThread(location: { file?: string; side?: 'base'; startLine?: number; endLine?: number }, body: string): Promise<void> {
    const { file, side, startLine, endLine } = location;
    const lines = file && startLine !== undefined ? await this.lines(file, side) : undefined;
    const snippet = lines?.slice(startLine! - 1, endLine).join('\n');
    return this.update((data) => data.threads.push({ id: newId(), ...location, snippet, resolved: false, comments: [newComment(body)] }));
  }

  reply(id: string, body: string, resolve = false): Promise<void> {
    return this.updateThread(id, (t) => {
      t.comments.push(newComment(body));
      if (resolve) t.resolved = true;
    });
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
      if (!ref) {
        const f = this.files.find((f) => f.path === file);
        return f && { file: f.path, side: f.status === 'D' ? 'base' : 'head' };
      }
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

  setViewed(files: ChangedFile[], viewed: boolean): Promise<void> {
    return this.enqueue(async () => {
      const all = { ...this.viewed() };
      if (viewed) {
        const blobs = await this.blobsOf(files, true);
        files.forEach((f, i) => {
          if (!blobs[i]) return;
          all[f.path] = blobs[i];
          this.blobs.set(f.path, blobs[i]);
        });
      } else {
        for (const f of files) delete all[f.path];
      }
      await this.state.update(this.viewedKey, all);
      this.snapshot = undefined;
      this.changed.fire({ external: false });
    });
  }

  dispose(): void {
    this.disposed = true;
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

  private async blobsOf(files: ChangedFile[], write: boolean): Promise<(string | undefined)[]> {
    const present = files.filter((f) => f.status !== 'D');
    const shas = this.targetDir ? await hashObjects(this.targetDir, present.map((f) => f.path), write) : [];
    return files.map((f) => (f.status === 'D' ? DELETED : this.targetDir ? shas[present.indexOf(f)] : f.blob));
  }

  private async loadChanges(): Promise<void> {
    const { base, target } = this.data;
    const targetSha = target ? await revParse(this.root, target) : undefined;
    const dir = target ? (await worktrees(this.root)).get(target) : this.root;
    const targetDir = target && dir === this.root ? undefined : dir;
    if (targetSha !== this.targetSha) contentProvider.refreshOpen();
    this.targetSha = targetSha;
    this.baseSha = await mergeBase(this.root, base, targetSha ?? 'HEAD');
    this.files = (await changedFiles(this.root, this.baseSha, { ref: targetDir ? undefined : targetSha, dir: targetDir })).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    this.changesError = undefined;
    if (targetDir !== this.targetDir) {
      this.targetDir = targetDir;
      this.targetWatcher?.dispose();
      this.targetWatcher = !this.disposed && targetDir && !isInside(targetDir, this.root) ? this.watch(targetDir) : undefined;
    }
    const viewed = this.viewed();
    const tracked = this.files.filter((f) => viewed[f.path]);
    const blobs = new Map<string, string>();
    if (this.targetDir) {
      const present = tracked.filter((f) => f.status !== 'D');
      const shas = await hashObjects(this.targetDir, present.map((f) => f.path), false).catch(() => []);
      present.forEach((f, i) => shas[i] && blobs.set(f.path, shas[i]));
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
        const lines = this.sources.get(sourceKey(t.file, t.side));
        if (lines) t.snippet = lines.slice(t.startLine - 1, t.endLine).join('\n');
      }
      await fs.writeFile(this.filePath, serializeReview(data));
      this.data = data;
      await this.reanchor();
      this.snapshot = undefined;
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
    // Git writes to .git all the time (index, objects, logs); only refs and worktrees affect the review.
    const schedule = (uri: vscode.Uri) => {
      const rel = path.relative(dir, uri.fsPath).split(path.sep).join('/');
      if (rel.startsWith('.git/') && !/^\.git\/(HEAD$|packed-refs$|refs\/|worktrees\/[^/]+(\/HEAD)?$)/.test(rel)) return;
      this.scheduleRefresh();
    };
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
    return watcher;
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
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
        const uri = vscode.Uri.file(path.join(this.targetDir, file));
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        text = doc?.isDirty ? doc.getText() : await fs.readFile(uri.fsPath, 'utf8');
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

}

function sourceKey(file: string, side?: 'base'): string {
  return `${side ?? 'head'}:${file}`;
}

function newComment(body: string) {
  return { author: REVIEWER, body, createdAt: new Date().toISOString() };
}
