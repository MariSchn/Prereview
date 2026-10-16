import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentsController, ReviewComment } from './comments';
import { FilesView } from './filesView';
import { ChangedFile, branches, git, repoRoot } from './git';
import { Review, SCHEME, contentProvider } from './review';

const ACTIVE_KEY = 'prereview.activeReview';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const comments = new CommentsController();
  const files = new FilesView();
  const tree = vscode.window.createTreeView('prereview.files', { treeDataProvider: files });
  let review: Review | undefined;
  let listener: vscode.Disposable | undefined;

  const setReview = (next: Review | undefined) => {
    listener?.dispose();
    review?.dispose();
    review = next;
    files.review = next;
    comments.setReview(next);
    const update = () => {
      files.refresh();
      comments.render();
      tree.description = next?.title;
      tree.message = next && !next.files.length ? 'No changes.' : undefined;
    };
    listener = next?.onDidChange(update);
    update();
    vscode.commands.executeCommand('setContext', 'prereview.active', !!next);
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

  context.subscriptions.push(
    comments,
    tree,
    { dispose: () => (listener?.dispose(), review?.dispose()) },
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    command('prereview.startReview', async () => {
      const next = await pickReview();
      if (next) setReview(next);
    }),
    command('prereview.openDiff', (file: ChangedFile) => review && openDiff(review, file)),
    command('prereview.openAllChanges', () => review && openAllChanges(review)),
    command('prereview.copyReviewPath', async () => {
      if (!review) return;
      await vscode.env.clipboard.writeText(review.filePath);
      vscode.window.showInformationMessage('Review path copied. Send it to your agent.');
    }),
    command('prereview.refresh', () => review?.refresh()),
    command('prereview.createThread', (reply: vscode.CommentReply) => comments.createThread(reply)),
    command('prereview.reply', (reply: vscode.CommentReply) => comments.reply(reply)),
    command('prereview.resolve', (thread: vscode.CommentThread) => comments.setResolved(thread, true)),
    command('prereview.unresolve', (thread: vscode.CommentThread) => comments.setResolved(thread, false)),
    command('prereview.deleteComment', (comment: ReviewComment) => comments.deleteComment(comment)),
  );

  const saved = context.workspaceState.get<string>(ACTIVE_KEY);
  if (saved && fs.existsSync(saved)) {
    try {
      setReview(await Review.load(saved));
    } catch (e) {
      vscode.window.showWarningMessage(`Prereview: could not restore review: ${(e as Error).message}`);
    }
  }
}

async function pickReview(): Promise<Review | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a folder inside a git repository first.');
  const root = await repoRoot(folder.uri.fsPath);
  const refs = await branches(root);
  const preferred = ['main', 'master', 'origin/main', 'origin/master'].find((b) => refs.includes(b));
  const ordered = preferred ? [preferred, ...refs.filter((r) => r !== preferred)] : refs;
  const base = await vscode.window.showQuickPick(ordered, { placeHolder: 'Base branch to compare against' });
  if (!base) return undefined;
  const head = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const targets: (vscode.QuickPickItem & { target: string | null })[] = [
    { label: '$(edit) Working tree', description: `${head} + uncommitted changes`, target: null },
    ...refs.filter((r) => r !== base).map((r) => ({ label: r, target: r })),
  ];
  const picked = await vscode.window.showQuickPick(targets, { placeHolder: `Compare ${base} with` });
  if (!picked) return undefined;
  return Review.open(root, base, picked.target);
}

function openDiff(review: Review, file: ChangedFile) {
  const [left, right] = review.diffUris(file);
  const title = `${path.posix.basename(file.path)} (${review.title})`;
  return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

function openAllChanges(review: Review) {
  const resources = review.files.map((f) => [vscode.Uri.file(path.join(review.root, f.path)), ...review.diffUris(f)]);
  return vscode.commands.executeCommand('vscode.changes', `Review: ${review.title}`, resources);
}
