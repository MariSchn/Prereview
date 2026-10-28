import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentsController, ReviewComment } from './comments';
import { TreeNode, flatten, orderFiles } from './fileTree';
import { FileItem, FilesView } from './filesView';
import { ChangedFile, branches, commitOf, defaultBase, git, repoRoot, worktrees } from './git';
import { FileError, Thread, ThreadStatus, countStatuses, describeFileError, pairLabel, reviewMarkdown, tildify } from './model';
import { Overview, VIEW_TYPE, confirmDelete } from './overview';
import { Review, ReviewChange, SCHEME, contentProvider, createReview, deleteReview } from './review';
import { ReviewEntry, ReviewsView, Suggestion, countsLabel, entryLabel, listReviews } from './reviewsView';

const ACTIVE_KEY = 'prereview.activeReview';
const TERMINAL_KEY = 'prereview.agentTerminal';
const HIDE_VIEWED_KEY = 'prereview.hideViewed';


// The active review and everything that shows it: the trees, comment threads, overview and status bar
export class Controller implements vscode.Disposable {
  review?: Review;
  private readonly comments: CommentsController;
  private readonly reviews = new ReviewsView();
  private readonly reviewsTree: vscode.TreeView<ReviewEntry | Suggestion>;
  private readonly files = new FilesView();
  private readonly tree: vscode.TreeView<TreeNode<ChangedFile>>;
  private readonly overview: Overview;
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[];
  private listener?: vscode.Disposable;
  private repositoryWatcher?: vscode.FileSystemWatcher;
  private counts = countStatuses([]);
  // Counts the reviews asked to open, so a slow one that finishes late doesn't replace a later choice
  private opening = 0;
  // The thread Next or Previous Open Thread last went to, and where that left the cursor
  private lastThread?: { id: string; cursor: string };
  readonly restored: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.comments = new CommentsController(vscode.Uri.joinPath(context.extensionUri, 'media'));
    this.reviewsTree = vscode.window.createTreeView('prereview.reviews', { treeDataProvider: this.reviews });
    this.tree = vscode.window.createTreeView('prereview.files', {
      treeDataProvider: this.files,
      manageCheckboxStateManually: true,
      showCollapseAll: true,
    });
    this.overview = new Overview(context.extensionUri, (thread) => (this.review ? openThread(this.review, thread) : Promise.resolve()));
    this.statusItem.command = 'prereview.openOverview';
    this.disposables = [
      this.reviews,
      this.reviewsTree,
      this.reviews.onDidChangeTreeData(() => {
        this.updateBadge();
        if (this.review && !fs.existsSync(this.review.filePath)) this.setReview(undefined);
      }),
      this.comments,
      this.tree,
      this.overview,
      this.statusItem,
      { dispose: () => (this.listener?.dispose(), this.review?.dispose()) },
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
      vscode.window.registerFileDecorationProvider(this.files),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => {
          await this.restored;
          this.overview.restore(panel);
        },
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.reveal(editor?.document.uri);
        this.updateActiveFile();
      }),
      // Threads in a file that is on screen count as looked at
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        const files = new Set(editors.map((e) => this.review?.fileOf(e.document.uri)?.path));
        this.review?.markRead(this.review.data.threads.filter((t) => t.file && files.has(t.file)).map((t) => t.id));
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.repository()),
      this.tree.onDidChangeCheckboxState(async (event) => {
        try {
          for (const [node, state] of event.items) {
            const changed = node.kind === 'file' ? [node.file] : flatten(node.children);
            await this.review?.setViewed(changed, state === vscode.TreeItemCheckboxState.Checked);
          }
        } catch (e) {
          vscode.window.showErrorMessage(`Prereview: ${(e as Error).message}`);
          this.files.refresh();
        }
      }),
      ...this.registerCommands(),
    ];
    this.files.hideViewed = context.workspaceState.get<boolean>(HIDE_VIEWED_KEY) ?? false;
    void vscode.commands.executeCommand('setContext', 'prereview.hidingViewed', this.files.hideViewed);
    this.restored = this.restore();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.repositoryWatcher?.dispose();
  }

  // Opens a review file, unless another review was asked for while it loaded
  async open(filePath: string): Promise<Review | undefined> {
    const ticket = ++this.opening;
    if (filePath === this.review?.filePath) return this.review;
    const next = await Review.load(filePath, this.context.workspaceState, await this.repository());
    if (ticket !== this.opening) {
      next.dispose();
      return undefined;
    }
    this.setReview(next);
    return next;
  }

  private async restore(): Promise<void> {
    await this.repository();
    const saved = this.context.workspaceState.get<string>(ACTIVE_KEY);
    if (!saved) return;
    try {
      await this.open(saved);
    } catch (e) {
      // A file that can't be read is still listed under Reviews, to fix or finish it there
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.context.workspaceState.update(ACTIVE_KEY, undefined);
      else vscode.window.showWarningMessage(`Prereview: ${(e as Error).message}`);
    }
  }

  // The repository the first workspace folder is in, looked up each time since one can be opened or created
  // later; its reviews are listed under Reviews
  private async repository(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const root = folder && (await repoRoot(folder.uri.fsPath).catch(() => undefined));
    void vscode.commands.executeCommand('setContext', 'prereview.noRepository', !!folder && !root);
    if (root) this.reviews.setRoot(root);
    this.repositoryWatcher?.dispose();
    this.repositoryWatcher = undefined;
    // A repository created in the folder, such as with Initialize Repository, shows up as a .git folder
    if (folder && !root) {
      this.repositoryWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git'));
      this.repositoryWatcher.onDidCreate(() => void this.repository());
    }
    return root;
  }

  private setReview(next: Review | undefined): void {
    this.listener?.dispose();
    this.review?.dispose();
    this.review = next;
    this.files.review = next;
    this.comments.setReview(next);
    this.overview.setReview(next);
    if (next) this.reviews.setRoot(next.root);
    this.reviews.setActive(next?.filePath);
    this.counts = countStatuses(next?.data.threads ?? []);
    this.listener = next?.onDidChange((change) => this.updateUi(change));
    void Promise.resolve(vscode.commands.executeCommand('setContext', 'prereview.active', !!next)).then(() => {
      if (this.review === next) this.updateUi({ external: false });
    });
    this.context.workspaceState.update(ACTIVE_KEY, next?.filePath);
  }

  private updateUi(change: ReviewChange): void {
    const review = this.review;
    this.files.refresh();
    this.comments.render();
    void this.overview.update();
    const next = countStatuses(review?.data.threads ?? []);
    if (review) {
      const viewed = review.files.filter((f) => review.viewState(f) === 'viewed').length;
      const updated = review.files.filter((f) => review.viewState(f) === 'updated').length;
      this.tree.description = review.title;
      this.tree.message = review.fileError
        ? `The review file ${describeFileError(review.fileError)}. Comments can't be saved until it is fixed.`
        : review.changesError
          ? review.changesError
          : review.files.length
            ? `${viewed} of ${review.files.length} files viewed${updated ? ` · ${updated} changed since viewed` : ''}`
            : undefined;
      this.statusItem.text = review.fileError ? '$(warning) Review file has an error' : statusText(next);
      this.statusItem.tooltip = review.fileError
        ? `Prereview: ${path.basename(review.filePath)} ${describeFileError(review.fileError)}`
        : `Prereview: ${review.title}`;
      this.statusItem.show();
      if (change.external && this.counts.awaitingAgent > 0 && next.awaitingAgent === 0 && next.awaitingYou > 0 && !this.overview.visible) {
        vscode.window.showInformationMessage('The agent replied to all open threads.', 'Open Overview').then((choice) => {
          if (choice) this.overview.show();
        });
      }
    } else {
      this.tree.description = undefined;
      this.tree.message = undefined;
      this.statusItem.hide();
    }
    this.counts = next;
    this.updateViewedContext();
    this.updateActiveFile();
    const noFiles = !!review && review.files.length === 0;
    const clean = noFiles && !review.changesError && review.data.threads.length === 0;
    const setContext = (key: string, value: unknown) => vscode.commands.executeCommand('setContext', key, value);
    setContext('prereview.noFiles', noFiles);
    setContext('prereview.hasUpdated', !!review?.files.some((f) => review.viewState(f) === 'updated'));
    setContext('prereview.noChanges', clean);
    setContext('prereview.emptyDiff', noFiles && !clean && !review?.changesError);
    setContext('prereview.changedSinceHandoff', !!review?.changedSinceHandoff().length);
  }

  // Each diff's title bar shows the viewed buttons for its own file, so the states are published per document
  private updateViewedContext(): void {
    const documents: Record<'viewed' | 'unviewed' | 'updated', string[]> = { viewed: [], unviewed: [], updated: [] };
    for (const f of this.review?.files ?? []) {
      const state = this.review!.viewState(f);
      for (const uri of this.review!.documentsOf(f)) {
        documents[state === 'viewed' ? 'viewed' : 'unviewed'].push(uri);
        if (state === 'updated') documents.updated.push(uri);
      }
    }
    void vscode.commands.executeCommand('setContext', 'prereview.viewedDocuments', documents.viewed);
    void vscode.commands.executeCommand('setContext', 'prereview.unviewedDocuments', documents.unviewed);
    void vscode.commands.executeCommand('setContext', 'prereview.updatedDocuments', documents.updated);
  }

  // A multi-diff editor's title bar has the multi-diff itself as its resource, so there the viewed buttons
  // follow the file with the focus
  private updateActiveFile(): void {
    const file = this.activeFile();
    const state = file && this.review?.viewState(file);
    void vscode.commands.executeCommand('setContext', 'prereview.activeFile', state && (state === 'viewed' ? 'viewed' : 'unviewed'));
    void vscode.commands.executeCommand('setContext', 'prereview.activeFileUpdated', state === 'updated');
  }

  private updateBadge(): void {
    const awaiting = this.reviews.entries.reduce((n, e) => n + e.counts.awaitingYou, 0);
    this.reviewsTree.badge = awaiting ? { value: awaiting, tooltip: `${awaiting} thread${awaiting === 1 ? '' : 's'} awaiting you` } : undefined;
  }

  // Selects the file of the active diff in Changed Files
  private reveal(uri?: vscode.Uri): void {
    const file = uri && this.review?.fileOf(uri);
    const node = file && this.files.nodeOf(file.path);
    if (node && this.tree.visible) void Promise.resolve(this.tree.reveal(node, { select: true, focus: false })).catch(() => undefined);
  }

  // The active review, or the given one, as Markdown, with the lines its threads are on now
  // Pastes the prompt into the terminal the agent runs in, without pressing Enter, so it can be checked first
  private async sendToTerminal(): Promise<void> {
    const review = this.review;
    if (!review) return;
    const terminals = [...vscode.window.terminals];
    if (!terminals.length) throw new Error('Open a terminal with your agent in it first.');
    const last = this.context.workspaceState.get<string>(TERMINAL_KEY);
    terminals.sort((a, b) => Number(b.name === last) - Number(a.name === last));
    const terminal =
      terminals.length === 1
        ? terminals[0]
        : (await vscode.window.showQuickPick(terminals.map((t) => ({ label: t.name, terminal: t })), { placeHolder: 'The terminal your agent runs in' }))?.terminal;
    if (!terminal) return;
    void this.context.workspaceState.update(TERMINAL_KEY, terminal.name);
    await review.handOff();
    terminal.show();
    terminal.sendText(review.prompt(), false);
  }

  private async markViewedAndNext(arg?: FileItem | ChangedFile | vscode.Uri): Promise<void> {
    const review = this.review;
    const file = this.fileArg(arg);
    if (!review || !file) return;
    await review.setViewed([file], true);
    const order = orderFiles(review.files);
    const after = [...order.slice(order.findIndex((f) => f.path === file.path) + 1), ...order];
    const next = after.find((f) => f.path !== file.path && review.viewState(f) !== 'viewed');
    if (next) await openDiff(review, next);
    else vscode.window.showInformationMessage('All files are viewed.');
  }

  // Opens the next or previous open thread after the cursor, in the order of Changed Files
  private async goToThread(step: 1 | -1): Promise<void> {
    const review = this.review;
    if (!review) return;
    const order = orderFiles(review.files).map((f) => f.path);
    const threads = review.data.threads
      .filter((t) => !t.resolved && t.file && order.includes(t.file))
      .map((t) => ({ t, at: [order.indexOf(t.file!), review.position(t)?.start ?? 0] }))
      .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    if (!threads.length) return void vscode.window.showInformationMessage('There are no open threads on changed files.');
    const editor = vscode.window.activeTextEditor;
    const file = editor && review.fileOf(editor.document.uri);
    const here = [file ? order.indexOf(file.path) : -1, editor ? editor.selection.active.line + 1 : 0];
    const from = (at: number[]) => at[0] - here[0] || at[1] - here[1];
    // A thread on deleted lines or on a whole file leaves the cursor where it was, so the next step starts from it
    const cursor = (e?: vscode.TextEditor) => e && `${e.document.uri}#${e.selection.active.line}`;
    const last = this.lastThread && this.lastThread.cursor === cursor(editor) ? threads.findIndex((x) => x.t.id === this.lastThread!.id) : -1;
    const next =
      last >= 0
        ? threads[(last + step + threads.length) % threads.length]
        : step > 0
          ? (threads.find((x) => from(x.at) > 0) ?? threads[0])
          : ([...threads].reverse().find((x) => from(x.at) < 0) ?? threads[threads.length - 1]);
    await openThread(review, next.t, false);
    review.markRead([next.t.id]);
    const after = cursor(vscode.window.activeTextEditor);
    this.lastThread = after ? { id: next.t.id, cursor: after } : undefined;
  }

  // Opens a file mentioned in a comment, in its diff if it changed, at the line given
  private async openPath(file: string, line?: number): Promise<void> {
    const review = this.review;
    if (!review) return;
    const at = line ? new vscode.Position(line - 1, 0) : undefined;
    const selection = at && new vscode.Range(at, at);
    const changed = review.files.find((f) => f.path === file);
    if (changed) await openDiff(review, changed, selection, true);
    else await vscode.window.showTextDocument(review.headUri(file), { selection, viewColumn: vscode.ViewColumn.Beside });
  }

  private setHideViewed(hide: boolean): void {
    this.files.hideViewed = hide;
    void this.context.workspaceState.update(HIDE_VIEWED_KEY, hide);
    void vscode.commands.executeCommand('setContext', 'prereview.hidingViewed', hide);
    this.files.refresh();
  }

  private markdown(entry?: ReviewEntry): string | undefined {
    const review = entry && entry.filePath !== this.review?.filePath ? undefined : this.review;
    // A file that can't be read has no comments to copy, unless it is the active review, which keeps the last ones read
    const data = review?.data ?? (entry?.error ? undefined : entry?.data);
    if (!data) return undefined;
    return reviewMarkdown(data, (t) => {
      const pos = review?.position(t) ?? (t.startLine === undefined ? undefined : { start: t.startLine, end: t.endLine ?? t.startLine });
      return pos && { start: pos.start, end: pos.end };
    });
  }

  private fileAt(uri?: vscode.Uri): ChangedFile | undefined {
    return uri ? this.review?.fileOf(uri) : undefined;
  }

  private activeFile(): ChangedFile | undefined {
    return this.fileAt(vscode.window.activeTextEditor?.document.uri);
  }

  // The file a command was run on: a Changed Files item, a file from the overview, an editor, or the active editor
  private fileArg(arg?: FileItem | ChangedFile | vscode.Uri): ChangedFile | undefined {
    if (arg instanceof vscode.Uri) return this.fileAt(arg) ?? this.activeFile();
    return arg ? ('kind' in arg ? arg.file : arg) : this.activeFile();
  }

  private registerCommands(): vscode.Disposable[] {
    const command = (id: string, fn: (...args: any[]) => unknown) =>
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (e) {
          vscode.window.showErrorMessage(`Prereview: ${(e as Error).message}`);
        }
      });
    const { comments, overview, files } = this;
    return [
      command('prereview.startReview', async () => {
        const root = await this.repository();
        if (!root) throw new Error(vscode.workspace.workspaceFolders ? "This folder isn't in a git repository." : 'Open a folder inside a git repository first.');
        const filePath = await pickReview(root, this.reviews.suggestions);
        if (filePath && (await this.open(filePath))) overview.show();
      }),
      command('prereview.reviewWorktree', async (suggestion: Suggestion) => {
        const root = await this.repository();
        const filePath = root && (await reviewWorktree(root, suggestion.branch));
        if (filePath && (await this.open(filePath))) overview.show();
      }),
      command('prereview.switchReview', async (entry: ReviewEntry) => {
        if (await this.open(entry.filePath)) overview.show();
      }),
      command('prereview.openOverview', () => overview.show()),
      command('prereview.openDiff', (arg: FileItem | ChangedFile, options?: { beside?: boolean }) => {
        const file = this.fileArg(arg);
        if (this.review && file) return openDiff(this.review, file, undefined, options?.beside);
      }),
      command('prereview.openFile', (arg?: FileItem | ChangedFile) => {
        const file = this.fileArg(arg);
        // A deleted file is only there in its old version
        if (this.review && file) return vscode.window.showTextDocument(file.status === 'D' ? this.review.baseUri(file.path) : this.review.headUri(file.path));
      }),
      command('prereview.copyFilePath', (arg?: FileItem | ChangedFile) => {
        const file = this.fileArg(arg);
        if (this.review && file) return vscode.env.clipboard.writeText(path.join(this.review.targetDir ?? this.review.root, file.path));
      }),
      command('prereview.copyRelativeFilePath', (arg?: FileItem | ChangedFile) => {
        const file = this.fileArg(arg);
        if (file) return vscode.env.clipboard.writeText(file.path);
      }),
      command('prereview.revealInExplorer', (arg?: FileItem | ChangedFile) => {
        const file = this.fileArg(arg);
        if (this.review && file) {
          return vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(this.review.targetDir ?? this.review.root, file.path)));
        }
      }),
      command('prereview.openSinceViewed', (arg: FileItem | ChangedFile, options?: { beside?: boolean }) => {
        const file = this.fileArg(arg);
        const uris = file && this.review?.sinceViewedUris(file);
        const title = file && `${path.posix.basename(file.path)} (since viewed)`;
        if (uris) return vscode.commands.executeCommand('vscode.diff', ...uris, title, { viewColumn: options?.beside ? vscode.ViewColumn.Beside : undefined });
      }),
      command('prereview.copyReviewMarkdown', async (entry?: ReviewEntry) => {
        const text = this.markdown(entry);
        if (!text) {
          if (entry?.error) vscode.window.showErrorMessage(`Prereview: ${path.basename(entry.filePath)} ${describeFileError(entry.error)}, so its comments can't be copied.`);
          return;
        }
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('Review copied as Markdown.');
      }),
      command('prereview.openAllSinceViewed', () => {
        const review = this.review;
        if (!review) return;
        const resources = files.orderedFiles.flatMap((f) => {
          const uris = review.sinceViewedUris(f);
          return uris && review.viewState(f) === 'updated' ? [[uris[1], ...uris]] : [];
        });
        if (resources.length) return vscode.commands.executeCommand('vscode.changes', `Since viewed: ${review.title}`, resources);
      }),
      command('prereview.openAllChanges', () => {
        const review = this.review;
        if (!review) return;
        if (!review.files.length) return overview.show();
        const dir = review.targetDir ?? review.root;
        const resources = orderFiles(review.files).map((f) => [vscode.Uri.file(path.join(dir, f.path)), ...review.diffUris(f)]);
        return vscode.commands.executeCommand('vscode.changes', `Review: ${review.title}`, resources);
      }),
      command('prereview.markViewed', (arg?: FileItem | ChangedFile | vscode.Uri) => {
        const file = this.fileArg(arg);
        if (file) return this.review?.setViewed([file], true);
      }),
      command('prereview.markUnviewed', (arg?: FileItem | ChangedFile | vscode.Uri) => {
        const file = this.fileArg(arg);
        if (file) return this.review?.setViewed([file], false);
      }),
      command('prereview.copyReviewPath', async (entry?: ReviewEntry) => {
        const filePath = entry?.filePath ?? this.review?.filePath;
        if (!filePath) return;
        if (filePath === this.review?.filePath) await this.review.handOff();
        await vscode.env.clipboard.writeText(filePath);
        vscode.window.showInformationMessage('Review path copied. Send it to your agent.');
      }),
      command('prereview.copyPrompt', async () => {
        const review = this.review;
        if (!review) return;
        await review.handOff();
        await vscode.env.clipboard.writeText(review.prompt());
        vscode.window.showInformationMessage('Prompt copied. Paste it into your agent.');
      }),
      command('prereview.sendToTerminal', () => this.sendToTerminal()),
      command('prereview.markViewedAndNext', (arg?: FileItem | ChangedFile | vscode.Uri) => this.markViewedAndNext(arg)),
      command('prereview.nextThread', () => this.goToThread(1)),
      command('prereview.previousThread', () => this.goToThread(-1)),
      command('prereview.applySuggestion', (threadId: string, commentId: string) => this.review?.applySuggestion(threadId, commentId)),
      command('prereview.openPath', (file: string, line?: number) => this.openPath(file, line)),
      command('prereview.openSinceComment', (arg: string | vscode.CommentThread, options?: { beside?: boolean }) => {
        const review = this.review;
        const id = typeof arg === 'string' ? arg : comments.threadIdOf(arg);
        const thread = review?.data.threads.find((t) => t.id === id);
        const uris = thread && review!.sinceCommentUris(thread);
        if (!thread || !uris) return vscode.window.showInformationMessage("The code hasn't changed since your last comment in this thread.");
        const pos = review!.position(thread);
        const at = pos && new vscode.Range(pos.start - 1, 0, pos.start - 1, 0);
        const viewColumn = options?.beside ? vscode.ViewColumn.Beside : undefined;
        return vscode.commands.executeCommand('vscode.diff', ...uris, `${path.posix.basename(thread.file!)} (since your comment)`, { selection: at, viewColumn });
      }),
      command('prereview.openSinceHandoff', () => {
        const review = this.review;
        if (!review) return;
        const resources = orderFiles(review.changedSinceHandoff()).flatMap((f) => {
          const uris = review.sinceHandoffUris(f);
          return uris ? [[uris[1], ...uris]] : [];
        });
        if (!resources.length) return vscode.window.showInformationMessage('Nothing changed since you handed the review to the agent.');
        return vscode.commands.executeCommand('vscode.changes', `Since hand-off: ${review.title}`, resources);
      }),
      command('prereview.openUnviewedChanges', () => {
        const review = this.review;
        if (!review) return;
        const resources = orderFiles(review.files)
          .filter((f) => !f.generated && review.viewState(f) !== 'viewed')
          .map((f) => [vscode.Uri.file(path.join(review.targetDir ?? review.root, f.path)), ...review.diffUris(f)]);
        if (!resources.length) return vscode.window.showInformationMessage('All files are viewed.');
        return vscode.commands.executeCommand('vscode.changes', `Not viewed: ${review.title}`, resources);
      }),
      command('prereview.hideViewedFiles', () => this.setHideViewed(true)),
      command('prereview.showViewedFiles', () => this.setHideViewed(false)),
      command('prereview.openReviewFile', async (entry?: { filePath: string; error?: FileError }) => {
        const filePath = entry?.filePath ?? this.review?.filePath;
        if (!filePath) return;
        const error = entry ? entry.error : this.review?.fileError;
        const at = error?.line === undefined ? undefined : new vscode.Position(error.line - 1, (error.column ?? 1) - 1);
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), { selection: at && new vscode.Range(at, at) });
      }),
      command('prereview.refresh', () => this.review?.refresh()),
      command('prereview.finishReview', async (entry?: ReviewEntry) => {
        const filePath = entry?.filePath ?? this.review?.filePath;
        if (!filePath) return;
        const title = entry ? entryLabel(entry) : this.review!.title;
        const copy = this.markdown(entry) ? 'Copy as Markdown and Finish' : undefined;
        const choice = await vscode.window.showWarningMessage(
          `Finish the review of ${title}?`,
          { modal: true, detail: `This deletes ${path.basename(filePath)} and all its comments.${copy ? ' To keep them, copy them as Markdown first.' : ''}` },
          'Finish Review',
          ...(copy ? [copy] : []),
        );
        if (!choice) return;
        if (choice === copy) await vscode.env.clipboard.writeText(this.markdown(entry) ?? '');
        if (filePath === this.review?.filePath) this.setReview(undefined);
        await deleteReview(filePath, this.context.workspaceState);
        await this.reviews.refresh();
      }),
      command('prereview.createThread', (reply: vscode.CommentReply) => comments.createThread(reply)),
      command('prereview.reply', (reply: vscode.CommentReply) => comments.reply(reply)),
      command('prereview.replyAndResolve', (reply: vscode.CommentReply) => comments.reply(reply, true)),
      command('prereview.expandThread', (id: string) => comments.expandThread(id)),
      command('prereview.resolve', (thread: vscode.CommentThread) => comments.setResolved(thread, true)),
      command('prereview.unresolve', (thread: vscode.CommentThread) => comments.setResolved(thread, false)),
      command('prereview.editComment', (comment: ReviewComment) => comments.editComment(comment)),
      command('prereview.saveComment', (comment: ReviewComment) => comments.saveComment(comment)),
      command('prereview.cancelEdit', (comment: ReviewComment) => comments.cancelEdit(comment)),
      command('prereview.deleteComment', async (comment: ReviewComment) => {
        if (await confirmDelete()) await comments.deleteComment(comment);
      }),
    ];
  }
}

function statusText(counts: Record<ThreadStatus, number>): string {
  if (counts.awaitingYou) return `$(comment-unresolved) ${counts.awaitingYou} awaiting you`;
  if (counts.awaitingAgent) return `$(comment-discussion) ${counts.awaitingAgent} awaiting agent`;
  if (counts.resolved) return '$(pass) All threads resolved';
  return '$(comment-discussion) Review';
}

// From the overview, diffs open beside it, so it stays in view as a list of what to look at
function openDiff(review: Review, file: ChangedFile, selection?: vscode.Range, beside = false) {
  const [left, right] = review.diffUris(file);
  const title = `${path.posix.basename(file.path)} (${review.title})`;
  const viewColumn = beside ? vscode.ViewColumn.Beside : undefined;
  return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, selection, viewColumn });
}

async function openThread(review: Review, thread: Thread, beside = true): Promise<void> {
  const uri = review.threadUri(thread);
  if (!uri || !thread.file) return;
  const pos = review.position(thread);
  const range = pos && new vscode.Range(pos.start - 1, 0, pos.end - 1, 0);
  const file = review.files.find((f) => f.path === thread.file);
  if (!file) {
    await vscode.window.showTextDocument(uri, { selection: range, viewColumn: beside ? vscode.ViewColumn.Beside : undefined });
    return;
  }
  await openDiff(review, file, thread.side === 'base' ? undefined : range, beside);
  if (thread.side === 'base' && range) {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    editor?.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
}

// Asks for a review to open, or what to compare in a new one, and returns the path of its file
async function pickReview(root: string, suggestions: Suggestion[]): Promise<string | undefined> {
  const existing = (await listReviews(root)).map((e) => ({
    label: e.error ? `$(warning) ${entryLabel(e)}` : e.data.title || pairLabel(e.data),
    description: e.data.title ? pairLabel(e.data) : undefined,
    detail: e.error ? `${path.basename(e.filePath)} ${describeFileError(e.error)}` : countsLabel(e.counts),
    filePath: e.filePath,
  }));
  const worktreeItems = suggestions.map((s) => ({ label: `$(add) Review ${s.branch}`, description: `worktree at ${tildify(s.dir)}`, branch: s.branch }));
  if (existing.length || worktreeItems.length) {
    const separator = (label: string) => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(add) New Review…' },
        ...(worktreeItems.length ? [separator('Agent worktrees'), ...worktreeItems] : []),
        ...(existing.length ? [separator('Open reviews'), ...existing] : []),
      ],
      { placeHolder: 'Open a review or start a new one' },
    );
    if (!picked) return undefined;
    if ('filePath' in picked) return picked.filePath;
    if ('branch' in picked) return reviewWorktree(root, picked.branch);
  }
  const refs = await branches(root);
  const base = await pickBase(root, refs);
  if (!base) return undefined;
  const head = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const trees = await worktrees(root);
  const elsewhere = (r: string) => trees.has(r) && trees.get(r) !== root;
  const candidates = refs.filter((r) => r !== base).sort((a, b) => Number(elsewhere(b)) - Number(elsewhere(a)));
  const targets: (vscode.QuickPickItem & { target: string | null })[] = [
    { label: '$(edit) Working tree', description: `${head} + uncommitted changes`, target: null },
    ...candidates.map((r) => ({
      label: r,
      description: elsewhere(r) ? `$(folder) worktree at ${tildify(trees.get(r)!)}, includes uncommitted changes` : undefined,
      target: r,
    })),
  ];
  const picked = await vscode.window.showQuickPick(targets, { placeHolder: `Compare ${base} with` });
  if (!picked) return undefined;
  return createReview(root, base, picked.target);
}

// Starts a review of a worktree's branch against the default branch, and asks for a base only without one
async function reviewWorktree(root: string, branch: string): Promise<string | undefined> {
  const refs = await branches(root);
  const base = defaultBase(refs) ?? (await pickBase(root, refs));
  return base && createReview(root, base, branch);
}

// A branch, most recently committed first, or any commit, tag or revision such as HEAD~3 typed in. A typed one
// is pinned to the commit it points at now, so the review doesn't shift as new commits come in.
async function pickBase(root: string, refs: string[]): Promise<string | undefined> {
  const preferred = defaultBase(refs);
  const items = (preferred ? [preferred, ...refs.filter((r) => r !== preferred)] : refs).map((label) => ({ label }));
  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = 'Base to compare against: a branch, or type a commit, tag or HEAD~3';
  quickPick.items = items;
  quickPick.onDidChangeValue((value) => {
    const typed = value.trim();
    quickPick.items = typed && !refs.includes(typed) ? [{ label: typed, description: 'commit, tag or revision' }, ...items] : items;
  });
  const picked = await new Promise<string | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0]?.label);
      quickPick.hide();
    });
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();
  if (!picked || refs.includes(picked)) return picked;
  return (await commitOf(root, picked)).slice(0, 12);
}
