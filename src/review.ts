import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile, catBlob, changedFiles, generatedPaths, git, hashObjects, ignoredPaths, mergeBase, revParse, show, worktreeList, worktrees } from './git';
import { listReviews } from './reviewsView';
import {
  AGENT_PROMPT,
  Comment,
  FileError,
  REVIEWER,
  REVIEW_AGENT_PROMPT,
  ReviewData,
  agentPrompt,
  ReviewDocument,
  Thread,
  describeFileError,
  fileError,
  follow,
  locate,
  matchesAt,
  newId,
  pairLabel,
  parseReview,
  readPair,
  reviewFilePath,
  serializeReview,
  suggestions,
} from './model';

export const SCHEME = 'prereview';
const DELETED = 'deleted';
// Git writes to .git all the time (objects, logs); only refs, the index, excludes and worktrees affect a review.
const GIT_STATE = /^\.git\/(HEAD$|packed-refs$|index$|info\/exclude$|refs\/|reftable\/|worktrees\/[^/]+(\/(HEAD|index))?$)/;
// Ask git again where branches point at least this often, in case a ref changed somewhere not watched
const REFS_TTL = 10_000;

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

function seenKey(filePath: string): string {
  return `prereview.seen:${filePath}`;
}

function readKey(filePath: string): string {
  return `prereview.read:${filePath}`;
}

function commentedKey(filePath: string): string {
  return `prereview.commented:${filePath}`;
}

function handoffKey(filePath: string): string {
  return `prereview.handoff:${filePath}`;
}

// Finds the review file of a pair, in any worktree, or creates it, and returns its path. A review of a branch
// checked out in another worktree goes in that worktree, where the agent working there may write it.
export async function createReview(root: string, base: string, target: string | null): Promise<string> {
  const trees = await worktreeList(root).catch(() => []);
  const existing = (await listReviews(root, trees)).find((e) => e.data.base === base && e.data.target === target);
  if (existing) return existing.filePath;
  const dir = (target && trees.find((w) => w.branch === target)?.dir) || root;
  const filePath = await reviewFilePath(dir, base, target);
  try {
    await fs.access(filePath);
  } catch {
    await writeReview(filePath, { title: '', description: '', base, target, threads: [] });
  }
  return filePath;
}

export async function deleteReview(filePath: string, state: vscode.Memento): Promise<void> {
  await fs.rm(filePath, { force: true });
  const keys = [viewedKey, anchorsKey, lastReadKey, seenKey, readKey, commentedKey, handoffKey].map((key) => key(filePath));
  for (const key of keys) await state.update(key, undefined);
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
  private readonly fileWatcher?: vscode.FileSystemWatcher;
  private readonly listeners: vscode.Disposable[];
  private targetWatcher?: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private firstEvent = 0;
  // File events since the last refresh: in .git, on the review file, and paths in the worktree under review
  private events = { git: false, review: false, paths: new Set<string>() };
  // Whether git ignores a path in the worktree under review; cleared when ignore rules change
  private ignored = new Map<string, boolean>();
  // How long the last full refresh took; refreshes wait longer when they are slow
  private cost = 0;
  // Code changed while the window was in the background; refresh once it is back
  private stale = false;
  private refsChanged = true;
  private refsChecked = 0;
  private refsWatched?: boolean;
  private shown = new Map<string, string>();
  private sourcesVersion = 0;
  private editTimer?: NodeJS.Timeout;
  private hintTimer?: NodeJS.Timeout;
  private edits = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private pendingRefresh?: Promise<void>;
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
  private pair?: string;
  private lastRead?: string;
  // When Prereview first saw each agent comment without a time of its own; '' for the ones that were already
  // there when the review was first opened
  private seen?: Record<string, string>;
  // When the reviewer last looked at each thread
  private looked: Record<string, string>;
  // The version of a thread's file when the reviewer last commented in it
  private commented: Record<string, { file: string; id: string }>;
  // The version of each file when the review was last handed to the agent
  private handoff?: { at: string; ids: Record<string, string> };
  private generated = new Set<string>();
  private generatedFor?: string;
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
    // A review kept in another worktree changes there, whatever that worktree has checked out
    this.fileWatcher = isInside(filePath, root) ? undefined : this.watch(path.dirname(filePath));
    this.hints = state.get<Record<string, [number, number]>>(anchorsKey(filePath)) ?? {};
    this.seen = state.get(seenKey(filePath));
    this.looked = state.get(readKey(filePath)) ?? {};
    this.commented = state.get(commentedKey(filePath)) ?? {};
    this.handoff = state.get(handoffKey(filePath));
    this.listeners = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.edited(e.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.edited(doc.uri)),
      vscode.window.onDidChangeWindowState((window) => {
        if (!window.focused || !this.stale) return;
        this.stale = false;
        void this.queueRefresh();
      }),
    ];
  }

  static async open(root: string, base: string, target: string | null, state: vscode.Memento): Promise<Review> {
    return Review.load(await createReview(root, base, target), state, root);
  }

  // `root` is the repository checkout the review is looked at from, which isn't where the file is when it was
  // kept in the worktree of the branch under review
  static async load(filePath: string, state: vscode.Memento, root = path.dirname(path.dirname(filePath))): Promise<Review> {
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
    const review = new Review(root, filePath, data, state);
    await review.refresh();
    return review;
  }

  get targetLabel(): string {
    return this.data.target ?? 'working tree';
  }

  get title(): string {
    return pairLabel(this.data);
  }

  // Reads everything again, including where the branches point
  refresh(): Promise<void> {
    this.refsChanged = true;
    return this.queueRefresh();
  }

  // A refresh that hasn't started yet covers later requests. One that has started may miss what changed since,
  // so another is queued, after the edits already waiting.
  private queueRefresh(): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh;
    const next: Promise<void> = this.enqueue(async () => {
      if (this.pendingRefresh === next) this.pendingRefresh = undefined;
      await this.refreshOnce();
    });
    this.pendingRefresh = next;
    return next;
  }

  private async refreshOnce(): Promise<void> {
    if (this.disposed) return;
    const started = Date.now();
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
    this.cost = Date.now() - started;
    this.announce(true);
  }

  // Picks up a change to the review file alone, without asking git anything
  private reload(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      const text = await fs.readFile(this.filePath, 'utf8').catch(() => undefined);
      if (text === undefined) return;
      this.read(text);
      await this.reanchor(new Set());
      this.remember();
      this.announce(true);
    });
  }

  // Tells the views about a change, unless nothing they show is different. Unrelated file activity triggers
  // refreshes too, and redrawing the views each time makes them flicker.
  private announce(external: boolean): void {
    const snapshot = JSON.stringify([
      this.data,
      this.fileError,
      this.files,
      this.changesError,
      this.baseSha,
      this.targetSha,
      this.targetDir,
      this.viewed(),
      this.looked,
      this.handoff?.at,
      [...this.blobs],
      [...this.pendingViewed],
      [...this.positions],
      this.sourcesVersion,
    ]);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.changed.fire({ external });
  }

  async addThread(location: { file?: string; side?: 'base'; startLine?: number; endLine?: number }, body: string): Promise<void> {
    const { file, side, startLine, endLine } = location;
    const text = file && startLine !== undefined ? await this.text(file, side) : undefined;
    const snippet = text?.split(/\r?\n/).slice(startLine! - 1, endLine).join('\n');
    let id = '';
    await this.update((doc) => (id = doc.addThread({ file, side, startLine, endLine, snippet }, newComment(body))));
    await this.noteCommented(id, file, side);
  }

  async reply(id: string, body: string, resolve = false): Promise<void> {
    await this.update((doc) => {
      doc.addComment(id, newComment(body));
      if (resolve) doc.setResolved(id, true);
    });
    this.markRead([id]);
    const thread = this.data.threads.find((t) => t.id === id);
    await this.noteCommented(id, thread?.file, thread?.side);
  }

  async setResolved(id: string, resolved: boolean): Promise<void> {
    await this.update((doc) => doc.setResolved(id, resolved));
    this.markRead([id]);
  }

  // When a comment was written, or for an agent comment without a time, when Prereview first saw it
  commentTime(thread: Thread, comment: Comment): string | undefined {
    return comment.createdAt ?? (this.seen?.[commentKey(thread.id, comment.id)] || undefined);
  }

  // Whether an agent comment arrived since the reviewer last looked at its thread, by when Prereview first saw it, as
  // an agent's times can be in another time zone or off
  isNew(thread: Thread, comment: Comment): boolean {
    return comment.author !== REVIEWER && (this.seen?.[commentKey(thread.id, comment.id)] ?? '') > (this.looked[thread.id] ?? '');
  }

  unread(thread: Thread): number {
    return thread.comments.filter((c) => this.isNew(thread, c)).length;
  }

  // Whether a suggestion in the thread can be applied: its lines are in a checked-out file and unchanged
  canApply(thread: Thread): boolean {
    return !!this.targetDir && !!thread.file && thread.side !== 'base' && this.position(thread)?.outdated === false;
  }

  // What to send the agent so it picks up the review, from the prereview.agentPrompt setting
  prompt(): string {
    return agentPrompt(vscode.workspace.getConfiguration('prereview').get<string>('agentPrompt') || AGENT_PROMPT, this.filePath);
  }

  // What to send an agent so it reviews the changes before the reviewer does, from the prereview.reviewAgentPrompt setting
  reviewAgentPrompt(): string {
    return agentPrompt(vscode.workspace.getConfiguration('prereview').get<string>('reviewAgentPrompt') || REVIEW_AGENT_PROMPT, this.filePath);
  }

  markRead(ids: string[]): void {
    const now = new Date().toISOString();
    const unread = ids.filter((id) => {
      const thread = this.data.threads.find((t) => t.id === id);
      return thread && this.unread(thread);
    });
    if (!unread.length) return;
    for (const id of unread) this.looked[id] = now;
    void this.state.update(readKey(this.filePath), this.looked);
    this.announce(false);
  }

  // Replaces a thread's lines with a comment's suggested code, saves the file and resolves the thread
  async applySuggestion(threadId: string, commentId: string): Promise<void> {
    const thread = this.data.threads.find((t) => t.id === threadId);
    const code = suggestions(thread?.comments.find((c) => c.id === commentId)?.body ?? '')[0];
    const pos = thread && this.position(thread);
    if (!thread?.file || code === undefined || !pos) return;
    if (!this.canApply(thread) || !this.targetDir) {
      throw new Error(pos.outdated ? 'The lines this suggestion replaces have changed since. Apply it by hand.' : 'Suggestions can only be applied to checked-out files.');
    }
    const uri = vscode.Uri.file(path.join(this.targetDir, thread.file));
    const doc = await vscode.workspace.openTextDocument(uri);
    // The file may have changed since the thread's position was worked out
    const source = this.source(thread);
    for (let line = pos.start - 1; line < pos.end; line++) {
      if (!source || line >= doc.lineCount || doc.lineAt(line).text !== source[line]) {
        throw new Error(`${thread.file} changed since the review was last updated. Try again in a moment.`);
      }
    }
    const edit = new vscode.WorkspaceEdit();
    // An empty suggestion removes the lines, line breaks included
    const end = code || pos.end >= doc.lineCount ? doc.lineAt(pos.end - 1).range.end : new vscode.Position(pos.end, 0);
    edit.replace(uri, new vscode.Range(pos.start - 1, 0, end.line, end.character), code);
    if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) throw new Error(`Couldn't change ${thread.file}.`);
    await this.reply(threadId, 'Applied the suggestion.', true);
  }

  // The version of a thread's file from when the reviewer last commented in it, next to the current one, if it changed since
  sinceCommentUris(thread: Thread): [vscode.Uri, vscode.Uri] | undefined {
    const at = this.commented[thread.id];
    const file = at && this.files.find((f) => f.path === at.file);
    if (!file || this.blobs.get(file.path) === at.id) return undefined;
    return [this.gitUri(file.path, { blob: at.id }), this.diffUris(file)[1]];
  }

  // Notes every file as it is now, when the review goes to the agent, to show later what the agent changed
  async handOff(): Promise<void> {
    await this.syncLines();
    const files = this.files;
    const ids = await this.blobsOf(files, true);
    files.forEach((f, i) => ids[i] && this.blobs.set(f.path, ids[i]!));
    this.handoff = { at: new Date().toISOString(), ids: Object.fromEntries(files.map((f, i) => [f.path, ids[i] ?? ''])) };
    await this.state.update(handoffKey(this.filePath), this.handoff);
    this.announce(false);
  }

  get handedOff(): string | undefined {
    return this.handoff?.at;
  }

  // Files the agent changed since the review was last handed to it, also ones it changed back to their base
  // version, which have left the diff
  changedSinceHandoff(): ChangedFile[] {
    const handoff = this.handoff;
    if (!handoff) return [];
    const paths = new Set(this.files.map((f) => f.path));
    const gone = Object.keys(handoff.ids).filter((p) => !paths.has(p));
    return [...this.files.filter((f) => this.blobs.get(f.path) !== handoff.ids[f.path]), ...gone.map((p): ChangedFile => ({ path: p, oldPath: p, status: 'M' }))];
  }

  sinceHandoffUris(file: ChangedFile): [vscode.Uri, vscode.Uri] | undefined {
    if (!this.handoff) return undefined;
    const id = this.handoff.ids[file.path];
    const left = id && /^[0-9a-f]{40,64}$/.test(id) ? this.gitUri(file.path, { blob: id }) : this.gitUri(file.path);
    // A file that left the diff is as it is in the base
    return [left, this.files.includes(file) ? this.diffUris(file)[1] : this.baseUri(file.path)];
  }

  private async noteCommented(threadId: string, file?: string, side?: 'base'): Promise<void> {
    const changed = file && side !== 'base' && this.files.find((f) => f.path === file);
    if (!changed) return;
    const [id] = await this.blobsOf([changed], true);
    if (!id || id === DELETED) return;
    this.commented[threadId] = { file: changed.path, id };
    this.blobs.set(changed.path, id);
    await this.state.update(commentedKey(this.filePath), this.commented);
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
      return pos && t.startLine !== undefined && !this.unsaved(t) && (pos.start !== t.startLine || pos.end !== t.endLine);
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
    // Only regular files are stored when viewed; for symlinks and submodules the id is not a blob
    const left = /^[0-9a-f]{40,64}$/.test(seen) ? this.gitUri(file.path, { blob: seen }) : this.gitUri(file.path);
    return [left, this.diffUris(file)[1]];
  }

  // Every document a review diff can show for a file, as URI strings
  documentsOf(file: ChangedFile): string[] {
    const uris = [...this.diffUris(file), ...(this.sinceViewedUris(file) ?? [])];
    return [...new Set(uris.map((uri) => uri.toString()))];
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
    let saved = false;
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
        saved = true;
      } finally {
        for (const f of files) {
          if (this.pendingViewed.get(f.path) === viewed) this.pendingViewed.delete(f.path);
        }
        // A failed save leaves nothing different to show, but the checkbox that was clicked needs to be put back
        if (!saved) this.snapshot = undefined;
        this.announce(false);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.shown.clear();
    clearTimeout(this.editTimer);
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.saveHints();
    }
    this.watcher.dispose();
    this.fileWatcher?.dispose();
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
    let targetDir = this.targetDir;
    // Branches only move with a write in .git, so edits to the code don't need git to look them up again. Where
    // git keeps its refs outside the folder watched, as in a linked worktree, they are looked up every time.
    this.refsWatched ??= await this.gitWatched();
    const pair = `${base}\n${target}`;
    if (this.refsChanged || !this.refsWatched || pair !== this.pair || Date.now() - this.refsChecked > REFS_TTL) {
      // Cleared first, so a write in .git while git is asked counts for the next refresh
      this.refsChanged = false;
      try {
        const targetSha = target ? await revParse(this.root, target) : undefined;
        const dir = target ? (await worktrees(this.root)).get(target) : this.root;
        targetDir = target && dir === this.root ? undefined : dir;
        if (targetSha !== this.targetSha) contentProvider.refreshOpen();
        this.targetSha = targetSha;
        this.baseSha = await mergeBase(this.root, base, targetSha ?? 'HEAD');
      } catch (e) {
        this.refsChanged = true;
        throw e;
      }
      this.pair = pair;
      this.refsChecked = Date.now();
    }
    this.files = (await changedFiles(this.root, this.baseSha, { ref: targetDir ? undefined : this.targetSha, dir: targetDir })).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    this.changesError = undefined;
    if (targetDir !== this.targetDir) {
      this.targetDir = targetDir;
      this.targetWatcher?.dispose();
      this.targetWatcher = !this.disposed && targetDir && !isInside(targetDir, this.root) ? this.watch(targetDir) : undefined;
    }
    const paths = this.files.map((f) => f.path);
    if (paths.join('\n') !== this.generatedFor) {
      this.generated = await generatedPaths(this.targetDir ?? this.root, paths).catch(() => new Set<string>());
      this.generatedFor = paths.join('\n');
    }
    for (const f of this.files) if (this.generated.has(f.path)) f.generated = true;
    // Versions are only needed of viewed files, files with threads to compare, and after a hand-off, of all
    const viewed = this.viewed();
    const commented = new Set(Object.values(this.commented).map((c) => c.file));
    const tracked = this.files.filter((f) => viewed[f.path] || commented.has(f.path) || this.handoff);
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
      this.note();
    } catch (e) {
      this.fileError = fileError(e as Error, text);
    }
  }

  // Notes when agent comments without a time of their own show up
  private note(): void {
    const first = !this.seen;
    const seen = (this.seen ??= {});
    const now = new Date().toISOString();
    let changed = first;
    for (const t of this.data.threads) {
      for (const c of t.comments) {
        const key = commentKey(t.id, c.id);
        if (c.author === REVIEWER || key in seen) continue;
        seen[key] = first ? '' : now;
        changed = true;
      }
    }
    if (changed) void this.state.update(seenKey(this.filePath), seen);
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
        this.announce(false);
        throw new Error(`${path.basename(this.filePath)} ${describeFileError(this.fileError)}, so the change was not saved.`);
      }
      edit(doc);
      this.keepLines(doc);
      const next = doc.toString();
      await fs.writeFile(this.filePath, next);
      this.read(next);
      await this.reanchor(new Set());
      this.remember();
      // The file watcher reports this write too; by then there is nothing new to show
      this.announce(false);
    });
  }

  // Writes the lines each thread is on now, and the code of threads the agent opened without it
  private keepLines(doc: ReviewDocument): void {
    for (const t of doc.data.threads) {
      if (!t.file || t.startLine === undefined || this.unsaved(t)) continue;
      const pos = this.positions.get(t.id);
      if (pos && (pos.start !== t.startLine || pos.end !== t.endLine)) doc.setLines(t.id, pos.start, pos.end);
      const lines = this.sources.get(sourceKey(t.file, t.side))?.lines;
      const start = pos?.start ?? t.startLine;
      if (t.snippet === undefined && lines && start <= lines.length && !pos?.outdated) {
        doc.setSnippet(t.id, lines.slice(start - 1, pos?.end ?? t.endLine).join('\n'));
      }
    }
  }

  // The agent reads the file on disk, so lines in a file with unsaved edits would point it at the wrong code
  private unsaved(t: Thread): boolean {
    if (t.side === 'base' || !t.file || !this.targetDir) return false;
    const uri = vscode.Uri.file(path.join(this.targetDir, t.file)).toString();
    return vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === uri);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private watch(dir: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '**/*'));
    const record = (uri: vscode.Uri) => this.record(dir, uri);
    watcher.onDidChange(record);
    watcher.onDidCreate(record);
    watcher.onDidDelete(record);
    return watcher;
  }

  // Notes what a file event can change. Only the worktree under review shows uncommitted changes; a branch
  // that isn't checked out only changes with writes in .git.
  private record(dir: string, uri: vscode.Uri): void {
    if (this.disposed) return;
    const rel = path.relative(dir, uri.fsPath).split(path.sep).join('/');
    // VS Code may spell the path differently, such as the drive letter in lower case
    if (!path.relative(this.filePath, uri.fsPath)) this.events.review = true;
    else if (dir === this.root && rel.startsWith('.git/')) {
      if (!GIT_STATE.test(rel)) return;
      // An ignored file that gets added is tracked from then on
      if (rel === '.git/info/exclude' || rel.endsWith('/index')) this.ignored.clear();
      this.events.git = true;
    } else {
      const file = this.targetDir && path.relative(this.targetDir, uri.fsPath).split(path.sep).join('/');
      if (!file || file.startsWith('..') || path.isAbsolute(file) || /^(\.git|\.prereview)(\/|$)/.test(file)) return;
      if (/(^|\/)\.gitignore$/.test(file)) this.ignored.clear();
      if (this.ignored.get(file)) return;
      this.events.paths.add(file);
    }
    this.schedule();
  }

  // Waits for a pause in file activity, but not indefinitely, and longer when refreshing is slow
  private schedule(): void {
    const now = Date.now();
    if (!this.timer) this.firstEvent = now;
    clearTimeout(this.timer);
    // Only changes to code wait longer when refreshing is slow; a reply in the review file is just read
    const code = this.events.git || this.events.paths.size > 0;
    const pause = code ? Math.max(300, this.cost * 2) : 300;
    const longest = code ? Math.max(1500, this.cost * 4) : 300;
    this.timer = setTimeout(() => void this.flush(), Math.max(0, Math.min(pause, this.firstEvent + longest - now)));
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const { git, review, paths } = this.events;
    this.events = { git: false, review: false, paths: new Set() };
    if (this.ignored.size > 5000) this.ignored.clear();
    const unknown = [...paths].filter((file) => !this.ignored.has(file));
    let unsure = false;
    if (unknown.length && this.targetDir) {
      const ignored = await ignoredPaths(this.targetDir, unknown);
      // Without an answer from git, they count as changes this time, and git is asked again next time
      if (ignored) for (const file of unknown) this.ignored.set(file, ignored.has(file));
      else unsure = true;
    }
    if (this.disposed) return;
    const code = git || unsure || [...paths].some((file) => this.ignored.get(file) === false);
    if (git) this.refsChanged = true;
    // In the background, only the review file is read, so agent replies still show up and notify
    if (code && !vscode.window.state.focused) this.stale = true;
    else if (code) return void this.queueRefresh();
    if (review) void this.reload();
  }

  // Whether git's own folders are the .git folder the watcher sees
  private async gitWatched(): Promise<boolean> {
    const dirs = (await git(this.root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']).catch(() => '')).trim().split('\n');
    const own = path.join(this.root, '.git');
    return dirs.length === 2 && dirs.every((dir) => !path.relative(own, path.resolve(this.root, dir)));
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
        if (!this.disposed && (await this.reanchor(edits))) this.announce(false);
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
    const read = sources.size !== this.sources.size || [...sources].some(([key, source]) => source?.text !== this.sources.get(key)?.text);
    const changed = read || !samePositions(positions, this.positions);
    if (read) this.sourcesVersion++;
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
    let pos: Position;
    if (known && before) {
      if (before.text === after.text) return known;
      const moved = follow(before.lines, after.lines, known, snippet);
      pos = { start: moved.start, end: moved.end, outdated: moved.lost || (!!snippet && !matchesAt(after.lines, moved.start, snippet)) };
    } else if (t.snippet === undefined) {
      pos = { ...stored, outdated: false };
    } else {
      const found = locate(after.lines, t.snippet, stored.start);
      pos = found ? { start: found.start, end: found.end, outdated: found.ambiguous } : { ...stored, outdated: true };
    }
    // Lines past the end of the file point at nothing: show the thread on the last line instead
    const last = after.lines.length;
    if (pos.end > last) return { start: Math.min(pos.start, last), end: last, outdated: true };
    return pos;
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
      if (side === 'base') return await this.show(this.baseSha, this.oldPath(file));
      if (this.targetDir) {
        const uri = vscode.Uri.file(path.join(this.targetDir, file));
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        return doc?.isDirty ? doc.getText() : await fs.readFile(uri.fsPath, 'utf8');
      }
      return await this.show(this.targetSha ?? this.data.target!, file);
    } catch {
      return undefined;
    }
  }

  // A file at a commit never changes, so it is only asked from git once
  private async show(sha: string, file: string): Promise<string> {
    const key = `${sha}:${file}`;
    let text = this.shown.get(key);
    if (text === undefined) {
      text = await show(this.root, sha, file);
      if (this.shown.size >= 200) this.shown.clear();
      this.shown.set(key, text);
    }
    return text;
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

function commentKey(threadId: string, commentId: string): string {
  return `${threadId}\n${commentId}`;
}
