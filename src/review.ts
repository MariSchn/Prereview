import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile, catBlob, changedFiles, hashObjects, mergeBase, revParse, show, worktrees } from './git';
import {
  FileError,
  REVIEWER,
  ReviewData,
  ReviewDocument,
  Thread,
  describeFileError,
  fileError,
  follow,
  locate,
  matchesAt,
  newId,
  parseReview,
  readPair,
  reviewFilePath,
  serializeReview,
} from './model';

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

function anchorsKey(filePath: string): string {
  return `prereview.anchors:${filePath}`;
}

function lastReadKey(filePath: string): string {
  return `prereview.lastRead:${filePath}`;
}

export async function deleteReview(filePath: string, state: vscode.Memento): Promise<void> {
  await fs.rm(filePath, { force: true });
  for (const key of [viewedKey(filePath), anchorsKey(filePath), lastReadKey(filePath)]) await state.update(key, undefined);
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

interface Source {
  text: string;
  lines: string[];
}

export class Review implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ReviewChange>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly listeners: vscode.Disposable[];
  private targetWatcher?: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private editTimer?: NodeJS.Timeout;
  private hintTimer?: NodeJS.Timeout;
  private edits = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private queuedRefresh?: Promise<void>;
  private refreshAgain = false;
  private warnings = new Set<string>();
  private disposed = false;
  private baseSha = '';
  private targetSha?: string;
  private positions = new Map<string, Position>();
  private sources = new Map<string, Source | undefined>();
  // Where each thread was last placed, to start from after a restart
  private hints: Record<string, [number, number]>;
  private blobs = new Map<string, string>();
  private pendingViewed = new Map<string, boolean>();
  private snapshot?: string;
  private lastRead?: string;
  files: ChangedFile[] = [];
  changesError?: string;
  // Set while the review file can't be read; `data` then still holds what was last read from it
  fileError?: FileError;
  targetDir?: string;

  private constructor(
    readonly root: string,
    readonly filePath: string,
    public data: ReviewData,
    private readonly state: vscode.Memento,
  ) {
    this.watcher = this.watch(root);
    this.hints = state.get<Record<string, [number, number]>>(anchorsKey(filePath)) ?? {};
    this.listeners = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.edited(e.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.edited(doc.uri)),
    ];
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
    const text = await fs.readFile(filePath, 'utf8');
    let data: ReviewData;
    try {
      data = parseReview(text);
    } catch (e) {
      // Open it on what was last read from it, or at least on what it compares, until the file is fixed
      const pair = readPair(text);
      const last = state.get<ReviewData>(lastReadKey(filePath));
      if (!last && !pair) throw new Error(`${path.basename(filePath)} ${describeFileError(fileError(e as Error, text))}.`);
      data = last ?? { title: '', description: '', base: pair!.base, target: pair!.target, threads: [] };
    }
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
    let text: string | undefined;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read ${path.basename(this.filePath)}: ${(e as Error).message}`);
    }
    if (text !== undefined) this.read(text);
    const targetDir = this.targetDir;
    try {
      await this.loadChanges();
    } catch (e) {
      warnings.push((e as Error).message);
      this.files = [];
      this.changesError = (e as Error).message;
    }
    // Absolute paths into the target's worktree can only be made relative once it is known
    if (text !== undefined && this.targetDir !== targetDir) this.read(text);
    if (this.disposed) return;
    for (const warning of warnings) {
      if (!this.warnings.has(warning)) vscode.window.showWarningMessage(`Prereview: ${warning}`);
    }
    this.warnings = new Set(warnings);
    await this.reanchor();
    this.remember();
    // Unrelated file activity triggers refreshes too; redrawing the views each time makes them flicker.
    const snapshot = JSON.stringify([
      this.data,
      this.fileError,
      this.files,
      this.changesError,
      this.baseSha,
      this.targetSha,
      this.targetDir,
      [...this.blobs],
      [...this.positions],
      [...this.sources],
    ]);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.changed.fire({ external: true });
  }

  async addThread(location: { file?: string; side?: 'base'; startLine?: number; endLine?: number }, body: string): Promise<void> {
    const { file, side, startLine, endLine } = location;
    const text = file && startLine !== undefined ? await this.text(file, side) : undefined;
    const snippet = text?.split(/\r?\n/).slice(startLine! - 1, endLine).join('\n');
    return this.update((doc) => doc.addThread({ file, side, startLine, endLine, snippet }, newComment(body)));
  }

  reply(id: string, body: string, resolve = false): Promise<void> {
    return this.update((doc) => {
      doc.addComment(id, newComment(body));
      if (resolve) doc.setResolved(id, true);
    });
  }

  setResolved(id: string, resolved: boolean): Promise<void> {
    return this.update((doc) => doc.setResolved(id, resolved));
  }

  editComment(threadId: string, commentId: string, body: string): Promise<void> {
    if (!body.trim()) return Promise.reject(new Error("A comment can't be empty."));
    return this.update((doc) => {
      const comment = doc.data.threads.find((t) => t.id === threadId)?.comments.find((c) => c.id === commentId);
      if (comment && comment.author !== REVIEWER) throw new Error('Only your own comments can be edited.');
      doc.editComment(threadId, commentId, body);
    });
  }

  deleteComment(threadId: string, commentId: string): Promise<void> {
    return this.update((doc) => doc.deleteComment(threadId, commentId));
  }

  // Writes the lines every thread is on now to the review file, so the agent finds them where they are
  syncLines(): Promise<void> {
    const moved = this.data.threads.some((t) => {
      const pos = this.positions.get(t.id);
      return pos && t.startLine !== undefined && (pos.start !== t.startLine || pos.end !== t.endLine);
    });
    return moved && !this.fileError ? this.update(() => undefined) : Promise.resolve();
  }

  position(thread: Thread): Position | undefined {
    if (thread.startLine === undefined) return undefined;
    return this.positions.get(thread.id) ?? { start: thread.startLine, end: thread.endLine ?? thread.startLine, outdated: true };
  }

  source(thread: Thread): string[] | undefined {
    return thread.file ? this.sources.get(sourceKey(thread.file, thread.side))?.lines : undefined;
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

  // The changed file a document belongs to, on either side of any review diff
  fileOf(uri: vscode.Uri): ChangedFile | undefined {
    if (uri.scheme === SCHEME) {
      const { ref, file } = JSON.parse(uri.query);
      if (ref && ref === this.baseSha) return this.files.find((f) => f.oldPath === file && f.status !== 'A');
      return this.files.find((f) => f.path === file);
    }
    if (uri.scheme === 'file' && this.targetDir) {
      const file = path.relative(this.targetDir, uri.fsPath).split(path.sep).join('/');
      return this.files.find((f) => f.path === file && f.status !== 'D');
    }
    return undefined;
  }

  // Where a comment left in a document belongs. Only the old and new version of a changed file take comments;
  // the empty side of an added or deleted file and the snapshot in "since viewed" diffs don't.
  commentLocation(uri: vscode.Uri): Location | undefined {
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
      return undefined;
    }
    const f = this.fileOf(uri);
    return f && { file: f.path, side: 'head' };
  }

  viewState(file: ChangedFile): ViewState {
    const pending = this.pendingViewed.get(file.path);
    if (pending !== undefined) return pending ? 'viewed' : 'unviewed';
    const seen = this.viewed()[file.path];
    if (!seen) return 'unviewed';
    return this.blobs.get(file.path) === seen ? 'viewed' : 'updated';
  }

  setViewed(files: ChangedFile[], viewed: boolean): Promise<void> {
    // Show the new state right away, so a refresh that finishes first does not briefly undo the checkbox.
    for (const f of files) this.pendingViewed.set(f.path, viewed);
    return this.enqueue(async () => {
      try {
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
      } finally {
        for (const f of files) {
          if (this.pendingViewed.get(f.path) === viewed) this.pendingViewed.delete(f.path);
        }
        this.snapshot = undefined;
        this.changed.fire({ external: false });
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.editTimer);
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.saveHints();
    }
    this.watcher.dispose();
    this.targetWatcher?.dispose();
    for (const listener of this.listeners) listener.dispose();
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

  private read(text: string): void {
    try {
      this.data = parseReview(text, { roots: this.roots() });
      this.fileError = undefined;
    } catch (e) {
      this.fileError = fileError(e as Error, text);
    }
  }

  // Folders an agent's absolute paths may point into, the target's worktree first since it can be inside the repository
  private roots(): string[] {
    return this.targetDir && this.targetDir !== this.root ? [this.targetDir, this.root] : [this.root];
  }

  // Keeps what was last read, to open the review on it while the file can't be read
  private remember(): void {
    if (this.fileError) return;
    const text = JSON.stringify(this.data);
    if (text === this.lastRead) return;
    this.lastRead = text;
    void this.state.update(lastReadKey(this.filePath), this.data);
  }

  private update(edit: (doc: ReviewDocument) => void): Promise<void> {
    return this.enqueue(async () => {
      const text = await fs.readFile(this.filePath, 'utf8');
      let doc: ReviewDocument;
      try {
        doc = new ReviewDocument(text, { roots: this.roots() });
      } catch (e) {
        this.fileError = fileError(e as Error, text);
        this.snapshot = undefined;
        this.changed.fire({ external: false });
        throw new Error(`${path.basename(this.filePath)} ${describeFileError(this.fileError)}, so the change was not saved.`);
      }
      edit(doc);
      this.keepLines(doc);
      const next = doc.toString();
      await fs.writeFile(this.filePath, next);
      this.read(next);
      await this.reanchor(new Set());
      this.remember();
      this.snapshot = undefined;
      this.changed.fire({ external: false });
    });
  }

  // Writes the lines each thread is on now, and the code of threads the agent opened without it
  private keepLines(doc: ReviewDocument): void {
    for (const t of doc.data.threads) {
      if (!t.file || t.startLine === undefined) continue;
      const pos = this.positions.get(t.id);
      if (pos && (pos.start !== t.startLine || pos.end !== t.endLine)) doc.setLines(t.id, pos.start, pos.end);
      const lines = this.sources.get(sourceKey(t.file, t.side))?.lines;
      if (t.snippet === undefined && lines) doc.setSnippet(t.id, lines.slice((pos?.start ?? t.startLine) - 1, pos?.end ?? t.endLine).join('\n'));
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private watch(dir: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '**/*'));
    // Git writes to .git all the time (objects, logs); only refs, the index, excludes and worktrees affect the review.
    const schedule = (uri: vscode.Uri) => {
      const rel = path.relative(dir, uri.fsPath).split(path.sep).join('/');
      const relevant = /^\.git\/(HEAD$|packed-refs$|index$|info\/exclude$|refs\/|reftable\/|worktrees\/[^/]+(\/(HEAD|index))?$)/;
      if (rel.startsWith('.git/') && !relevant.test(rel)) return;
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

  // Threads move with the code while it is edited, before it is saved
  private edited(uri: vscode.Uri): void {
    if (this.disposed || uri.scheme !== 'file' || !this.targetDir) return;
    const key = sourceKey(path.relative(this.targetDir, uri.fsPath).split(path.sep).join('/'));
    if (!this.sources.has(key)) return;
    this.edits.add(key);
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => {
      const edits = this.edits;
      this.edits = new Set();
      void this.enqueue(async () => {
        if (this.disposed || !(await this.reanchor(edits))) return;
        this.snapshot = undefined;
        this.changed.fire({ external: false });
      });
    }, 150);
  }

  // Puts every thread on the lines it is about now, following it from where it was in the file's previous
  // version. Files in `only` are read again and the others reused; without `only`, all are read.
  private async reanchor(only?: Set<string>): Promise<boolean> {
    const sources = new Map<string, Source | undefined>();
    const positions = new Map<string, Position>();
    for (const t of this.data.threads) {
      if (!t.file || t.startLine === undefined) continue;
      const key = sourceKey(t.file, t.side);
      if (!sources.has(key)) {
        const reuse = only && !only.has(key) && this.sources.has(key);
        sources.set(key, reuse ? this.sources.get(key) : await this.readSource(t.file, t.side));
      }
      positions.set(t.id, this.anchor(t, this.sources.get(key), sources.get(key)));
    }
    const changed =
      !samePositions(positions, this.positions) ||
      sources.size !== this.sources.size ||
      [...sources].some(([key, source]) => source?.text !== this.sources.get(key)?.text);
    this.sources = sources;
    this.positions = positions;
    if (changed) {
      clearTimeout(this.hintTimer);
      this.hintTimer = setTimeout(() => this.saveHints(), 1000);
    }
    return changed;
  }

  private anchor(t: Thread, before: Source | undefined, after: Source | undefined): Position {
    const known = this.positions.get(t.id);
    const hint = this.hints[t.id];
    const stored = hint ? { start: hint[0], end: hint[1] } : { start: t.startLine!, end: t.endLine ?? t.startLine! };
    if (!after) return { ...(known ?? stored), outdated: true };
    const snippet = t.snippet?.split('\n');
    if (known && before) {
      if (before.text === after.text) return known;
      const moved = follow(before.lines, after.lines, known, snippet);
      return { start: moved.start, end: moved.end, outdated: moved.lost || (!!snippet && !matchesAt(after.lines, moved.start, snippet)) };
    }
    if (t.snippet === undefined) return { ...stored, outdated: false };
    const found = locate(after.lines, t.snippet, stored.start);
    return found ? { start: found.start, end: found.end, outdated: found.ambiguous } : { ...stored, outdated: true };
  }

  private saveHints(): void {
    this.hintTimer = undefined;
    this.hints = Object.fromEntries([...this.positions].map(([id, p]) => [id, [p.start, p.end]]));
    void this.state.update(anchorsKey(this.filePath), this.hints);
  }

  private async readSource(file: string, side?: 'base'): Promise<Source | undefined> {
    const text = await this.text(file, side);
    return text === undefined ? undefined : { text, lines: text.split(/\r?\n/) };
  }

  private async text(file: string, side?: 'base'): Promise<string | undefined> {
    try {
      if (side === 'base') return await show(this.root, this.baseSha, this.oldPath(file));
      if (this.targetDir) {
        const uri = vscode.Uri.file(path.join(this.targetDir, file));
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        return doc?.isDirty ? doc.getText() : await fs.readFile(uri.fsPath, 'utf8');
      }
      return await show(this.root, this.data.target!, file);
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

function samePositions(a: Map<string, Position>, b: Map<string, Position>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, p] of a) {
    const q = b.get(id);
    if (!q || q.start !== p.start || q.end !== p.end || q.outdated !== p.outdated) return false;
  }
  return true;
}

function newComment(body: string) {
  return { id: newId(), author: REVIEWER, body, createdAt: new Date().toISOString() };
}
