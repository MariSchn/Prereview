import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentsController, ReviewComment } from './comments';
import { flatten } from './fileTree';
import { FileItem, FilesView } from './filesView';
import { ChangedFile, branches, git, repoRoot, worktrees } from './git';
import { Thread, ThreadStatus, countStatuses, pairLabel } from './model';
import { Overview, confirmDelete } from './overview';
import { Review, ReviewChange, SCHEME, contentProvider, deleteReview } from './review';
import { ReviewEntry, ReviewsView, countsLabel, listReviews } from './reviewsView';

const ACTIVE_KEY = 'prereview.activeReview';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const comments = new CommentsController(vscode.Uri.joinPath(context.extensionUri, 'media'));
  const reviews = new ReviewsView();
  const reviewsTree = vscode.window.createTreeView('prereview.reviews', { treeDataProvider: reviews });
  const files = new FilesView();
  const tree = vscode.window.createTreeView('prereview.files', { treeDataProvider: files, manageCheckboxStateManually: true });
  const overview = new Overview(context.extensionUri, (thread) => (review ? openThread(review, thread) : Promise.resolve()));
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'prereview.openOverview';
  let review: Review | undefined;
  let listener: vscode.Disposable | undefined;
  let counts = countStatuses([]);

  const fileAt = (uri?: vscode.Uri): ChangedFile | undefined => {
    const location = uri && review?.locationOf(uri);
    return location ? review?.files.find((f) => f.path === location.file) : undefined;
  };
  const activeFile = () => fileAt(vscode.window.activeTextEditor?.document.uri);

  const updateEditorContext = () => {
    const file = activeFile();
    const state = file && review?.viewState(file) === 'viewed' ? 'viewed' : file ? 'unviewed' : undefined;
    vscode.commands.executeCommand('setContext', 'prereview.activeFile', state);
    vscode.commands.executeCommand('setContext', 'prereview.activeFileUpdated', !!file && review?.viewState(file) === 'updated');
  };

  const updateUi = (change: ReviewChange) => {
    files.refresh();
    comments.render();
    void overview.update();
    const next = countStatuses(review?.data.threads ?? []);
    if (review) {
      const viewed = review.files.filter((f) => review!.viewState(f) === 'viewed').length;
      const updated = review.files.filter((f) => review!.viewState(f) === 'updated').length;
      tree.description = review.title;
      tree.message = review.changesError
        ? review.changesError
        : review.files.length
          ? `${viewed} of ${review.files.length} files viewed${updated ? ` · ${updated} changed since viewed` : ''}`
          : undefined;
      statusItem.text = statusText(next);
      statusItem.tooltip = `Prereview: ${review.title}`;
      statusItem.show();
      if (change.external && counts.awaitingAgent > 0 && next.awaitingAgent === 0 && next.awaitingYou > 0 && !overview.visible) {
        vscode.window.showInformationMessage('The agent replied to all open threads.', 'Open Overview').then((choice) => {
          if (choice) overview.show();
        });
      }
    } else {
      tree.description = undefined;
      tree.message = undefined;
      statusItem.hide();
    }
    counts = next;
    updateEditorContext();
    const noFiles = !!review && review.files.length === 0;
    const clean = noFiles && review !== undefined && !review.changesError && review.data.threads.length === 0;
    vscode.commands.executeCommand('setContext', 'prereview.noFiles', noFiles);
    vscode.commands.executeCommand('setContext', 'prereview.hasUpdated', !!review?.files.some((f) => review!.viewState(f) === 'updated'));
    vscode.commands.executeCommand('setContext', 'prereview.noChanges', clean);
    vscode.commands.executeCommand('setContext', 'prereview.emptyDiff', noFiles && !clean && !review?.changesError);
  };

  const updateBadge = () => {
    const awaiting = reviews.entries.reduce((n, e) => n + e.counts.awaitingYou, 0);
    reviewsTree.badge = awaiting
      ? { value: awaiting, tooltip: `${awaiting} thread${awaiting === 1 ? '' : 's'} awaiting you` }
      : undefined;
  };

  const setReview = (next: Review | undefined) => {
    listener?.dispose();
    review?.dispose();
    review = next;
    files.review = next;
    comments.setReview(next);
    overview.setReview(next);
    reviews.setActive(next?.filePath);
    counts = countStatuses(next?.data.threads ?? []);
    listener = next?.onDidChange(updateUi);
    void Promise.resolve(vscode.commands.executeCommand('setContext', 'prereview.active', !!next)).then(() => {
      if (review === next) updateUi({ external: false });
    });
    context.workspaceState.update(ACTIVE_KEY, next?.filePath);
  };

  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        vscode.window.showErrorMessage(`Prereview: ${(e as Error).message}`);
      }
    });

  const fileArg = (arg?: FileItem | ChangedFile | vscode.Uri): ChangedFile | undefined => {
    if (arg instanceof vscode.Uri) return fileAt(arg) ?? activeFile();
    return arg ? ('kind' in arg ? arg.file : arg) : activeFile();
  };

  context.subscriptions.push(
    reviews,
    reviewsTree,
    reviews.onDidChangeTreeData(() => {
      updateBadge();
      if (review && !fs.existsSync(review.filePath)) setReview(undefined);
    }),
    comments,
    tree,
    overview,
    statusItem,
    { dispose: () => (listener?.dispose(), review?.dispose()) },
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(files),
    vscode.window.onDidChangeActiveTextEditor(updateEditorContext),
    tree.onDidChangeCheckboxState(async (event) => {
      try {
        for (const [node, state] of event.items) {
          const changed = node.kind === 'file' ? [node.file] : flatten(node.children);
          await review?.setViewed(changed, state === vscode.TreeItemCheckboxState.Checked);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Prereview: ${(e as Error).message}`);
        files.refresh();
      }
    }),
    command('prereview.startReview', async () => {
      const next = await pickReview(context.workspaceState);
      if (!next) return;
      setReview(next);
      overview.show();
    }),
    command('prereview.switchReview', async (entry: ReviewEntry) => {
      if (entry.filePath !== review?.filePath) setReview(await Review.load(entry.filePath, context.workspaceState));
      overview.show();
    }),
    command('prereview.openOverview', () => overview.show()),
    command('prereview.openDiff', (arg: FileItem | ChangedFile) => {
      const file = fileArg(arg);
      if (review && file) return openDiff(review, file);
    }),
    command('prereview.openSinceViewed', (arg: FileItem | ChangedFile) => {
      const file = fileArg(arg);
      const uris = file && review?.sinceViewedUris(file);
      if (file && uris) return vscode.commands.executeCommand('vscode.diff', ...uris, `${path.posix.basename(file.path)} (since viewed)`);
    }),
    command('prereview.openAllSinceViewed', () => {
      if (!review) return;
      const resources = files.orderedFiles.flatMap((f) => {
        const uris = review!.sinceViewedUris(f);
        return uris && review!.viewState(f) === 'updated' ? [[uris[1], ...uris]] : [];
      });
      if (resources.length) return vscode.commands.executeCommand('vscode.changes', `Since viewed: ${review.title}`, resources);
    }),
    command('prereview.openAllChanges', () => {
      if (!review) return;
      if (!review.files.length) return overview.show();
      const dir = review.targetDir ?? review.root;
      const resources = files.orderedFiles.map((f) => [vscode.Uri.file(path.join(dir, f.path)), ...review!.diffUris(f)]);
      return vscode.commands.executeCommand('vscode.changes', `Review: ${review.title}`, resources);
    }),
    command('prereview.markViewed', (arg?: FileItem | ChangedFile) => {
      const file = fileArg(arg);
      if (file) return review?.setViewed([file], true);
    }),
    command('prereview.markUnviewed', (arg?: FileItem | ChangedFile) => {
      const file = fileArg(arg);
      if (file) return review?.setViewed([file], false);
    }),
    command('prereview.copyReviewPath', async (entry?: ReviewEntry) => {
      const filePath = entry?.filePath ?? review?.filePath;
      if (!filePath) return;
      await vscode.env.clipboard.writeText(filePath);
      vscode.window.showInformationMessage('Review path copied. Send it to your agent.');
    }),
    command('prereview.refresh', () => review?.refresh()),
    command('prereview.finishReview', async (entry?: ReviewEntry) => {
      const filePath = entry?.filePath ?? review?.filePath;
      if (!filePath) return;
      const title = entry ? pairLabel(entry.data) : review!.title;
      const choice = await vscode.window.showWarningMessage(
        `Finish the review of ${title}?`,
        { modal: true, detail: `This deletes ${path.basename(filePath)} and all its comments.` },
        'Finish Review',
      );
      if (choice !== 'Finish Review') return;
      if (filePath === review?.filePath) setReview(undefined);
      await deleteReview(filePath, context.workspaceState);
      await reviews.refresh();
    }),
    command('prereview.createThread', (reply: vscode.CommentReply) => comments.createThread(reply)),
    command('prereview.reply', (reply: vscode.CommentReply) => comments.reply(reply)),
    command('prereview.replyAndResolve', (reply: vscode.CommentReply) => comments.reply(reply, true)),
    command('prereview.resolve', (thread: vscode.CommentThread) => comments.setResolved(thread, true)),
    command('prereview.unresolve', (thread: vscode.CommentThread) => comments.setResolved(thread, false)),
    command('prereview.editComment', (comment: ReviewComment) => comments.editComment(comment)),
    command('prereview.saveComment', (comment: ReviewComment) => comments.saveComment(comment)),
    command('prereview.cancelEdit', () => comments.cancelEdit()),
    command('prereview.deleteComment', async (comment: ReviewComment) => {
      if (await confirmDelete()) await comments.deleteComment(comment);
    }),
  );

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    repoRoot(folder.uri.fsPath).then(
      (root) => reviews.setRoot(root),
      () => undefined,
    );
  }

  const saved = context.workspaceState.get<string>(ACTIVE_KEY);
  if (saved) {
    try {
      setReview(await Review.load(saved, context.workspaceState));
    } catch {
      context.workspaceState.update(ACTIVE_KEY, undefined);
    }
  }
}

function statusText(counts: Record<ThreadStatus, number>): string {
  if (counts.awaitingYou) return `$(comment-unresolved) ${counts.awaitingYou} awaiting you`;
  if (counts.awaitingAgent) return `$(comment-discussion) ${counts.awaitingAgent} awaiting agent`;
  if (counts.resolved) return '$(pass) All threads resolved';
  return '$(comment-discussion) Review';
}

function openDiff(review: Review, file: ChangedFile, selection?: vscode.Range) {
  const [left, right] = review.diffUris(file);
  const title = `${path.posix.basename(file.path)} (${review.title})`;
  return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, selection });
}

async function openThread(review: Review, thread: Thread): Promise<void> {
  const uri = review.threadUri(thread);
  if (!uri || !thread.file) return;
  const pos = review.position(thread);
  const range = pos && new vscode.Range(pos.start - 1, 0, pos.end - 1, 0);
  const file = review.files.find((f) => f.path === thread.file);
  if (!file) {
    await vscode.window.showTextDocument(uri, { selection: range });
    return;
  }
  await openDiff(review, file, thread.side === 'base' ? undefined : range);
  if (thread.side === 'base' && range) {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    editor?.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
}

async function pickReview(state: vscode.Memento): Promise<Review | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a folder inside a git repository first.');
  const root = await repoRoot(folder.uri.fsPath);
  const existing = (await listReviews(root)).map((e) => ({
    label: e.data.title || pairLabel(e.data),
    description: e.data.title ? pairLabel(e.data) : undefined,
    detail: countsLabel(e.counts),
    filePath: e.filePath,
  }));
  if (existing.length) {
    const picked = await vscode.window.showQuickPick(
      [{ label: '$(add) New Review…' }, { label: 'Open reviews', kind: vscode.QuickPickItemKind.Separator }, ...existing],
      { placeHolder: 'Open a review or start a new one' },
    );
    if (!picked) return undefined;
    if ('filePath' in picked) return Review.load(picked.filePath, state);
  }
  const refs = await branches(root);
  const preferred = ['main', 'master', 'origin/main', 'origin/master'].find((b) => refs.includes(b));
  const ordered = preferred ? [preferred, ...refs.filter((r) => r !== preferred)] : refs;
  const base = await vscode.window.showQuickPick(ordered, { placeHolder: 'Base branch to compare against' });
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
  return Review.open(root, base, picked.target, state);
}

function tildify(dir: string): string {
  const home = os.homedir();
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}
