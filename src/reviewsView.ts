import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { worktreeList } from './git';
import { FileError, ReviewData, ThreadStatus, countStatuses, describeFileError, fileError, pairLabel, parseReview, readPair, tildify } from './model';

export interface ReviewEntry {
  filePath: string;
  data: ReviewData;
  counts: Record<ThreadStatus, number>;
  // Set when the file can't be read; `data` then only holds what it compares, if that could be found
  error?: FileError;
}

// A branch checked out in another worktree, such as an agent's, that has no review yet
export interface Suggestion {
  branch: string;
  dir: string;
}

// The reviews of a repository: in its own .prereview folder, and in those of its other worktrees
export async function listReviews(root: string, dirs?: string[]): Promise<ReviewEntry[]> {
  dirs ??= [root, ...(await worktreeList(root).catch(() => [])).map((w) => w.dir).filter((dir) => dir !== root)];
  return (await Promise.all(dirs.map(readReviews))).flat();
}

async function readReviews(worktree: string): Promise<ReviewEntry[]> {
  const dir = path.join(worktree, '.prereview');
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const entries: ReviewEntry[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const filePath = path.join(dir, name);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    try {
      const data = parseReview(text);
      entries.push({ filePath, data, counts: countStatuses(data.threads) });
    } catch (e) {
      const pair = readPair(text);
      const data = { title: '', description: '', base: pair?.base ?? '', target: pair?.target ?? null, threads: [] };
      entries.push({ filePath, data, counts: countStatuses([]), error: fileError(e as Error, text) });
    }
  }
  return entries;
}

// What a review compares, or its file name when that can't be read from it
export function entryLabel(entry: ReviewEntry): string {
  return entry.data.base ? pairLabel(entry.data) : path.basename(entry.filePath);
}

export function countsLabel(counts: Record<ThreadStatus, number>): string {
  return (
    [
      counts.awaitingYou && `${counts.awaitingYou} awaiting you`,
      counts.awaitingAgent && `${counts.awaitingAgent} awaiting agent`,
      counts.resolved && `${counts.resolved} resolved`,
    ]
      .filter(Boolean)
      .join(' · ') || 'No comments yet'
  );
}

function icon(counts: Record<ThreadStatus, number>): vscode.ThemeIcon {
  if (counts.awaitingYou) return new vscode.ThemeIcon('comment-unresolved', new vscode.ThemeColor('list.warningForeground'));
  if (counts.awaitingAgent) return new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.purple'));
  if (counts.resolved) return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
  return new vscode.ThemeIcon('git-pull-request');
}

type Item = ReviewEntry | Suggestion;

export class ReviewsView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private watchers: vscode.FileSystemWatcher[] = [];
  private watched = '';
  private timer?: NodeJS.Timeout;
  private version = 0;
  private root?: string;
  entries: ReviewEntry[] = [];
  suggestions: Suggestion[] = [];
  active?: string;

  setRoot(root: string): void {
    if (root === this.root) return;
    this.root = root;
    void this.refresh();
  }

  setActive(filePath: string | undefined): void {
    this.active = filePath;
    this.changed.fire();
  }

  async refresh(): Promise<void> {
    const version = ++this.version;
    const root = this.root;
    const trees = root ? await worktreeList(root).catch(() => [{ dir: root, branch: undefined }]) : [];
    const dirs = root ? [root, ...trees.map((w) => w.dir).filter((dir) => dir !== root)] : [];
    const entries = root ? await listReviews(root, dirs) : [];
    if (version !== this.version) return;
    if (root) this.watch(root, dirs);
    this.entries = entries;
    this.suggestions = trees
      .filter((w) => w.branch && w.dir !== root && !entries.some((e) => e.data.target === w.branch))
      .map((w) => ({ branch: w.branch!, dir: w.dir }));
    this.changed.fire();
  }

  // The review folders of all worktrees, and the repository's list of worktrees, which agents add and remove
  private watch(root: string, dirs: string[]): void {
    const key = dirs.join('\n');
    if (key === this.watched) return;
    this.watched = key;
    for (const watcher of this.watchers) watcher.dispose();
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), 300);
    };
    const patterns = [...dirs.map((dir) => new vscode.RelativePattern(dir, '.prereview/*.json')), new vscode.RelativePattern(root, '.git/worktrees/*')];
    this.watchers = patterns.map((pattern) => {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      return watcher;
    });
  }

  getChildren(item?: Item): Item[] {
    return item ? [] : [...this.entries, ...this.suggestions];
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if (!('filePath' in item)) {
      const suggestion = new vscode.TreeItem(`Review ${item.branch}`);
      suggestion.id = `suggestion:${item.dir}`;
      suggestion.description = `worktree at ${tildify(item.dir)}`;
      suggestion.tooltip = `${item.branch} is checked out in ${item.dir}. Start a review of it.`;
      suggestion.iconPath = new vscode.ThemeIcon('add');
      suggestion.contextValue = 'suggestion';
      suggestion.command = { command: 'prereview.reviewWorktree', title: 'Start Review', arguments: [item] };
      return suggestion;
    }
    const entry = item;
    const pair = entryLabel(entry);
    const active = entry.filePath === this.active;
    const tree = new vscode.TreeItem(entry.data.title || pair);
    tree.id = entry.filePath;
    tree.description = [active && 'active', entry.data.title && pair, entry.error ? "can't be read" : turn(entry.counts)].filter(Boolean).join(' · ');
    tree.tooltip = entry.error
      ? `${path.basename(entry.filePath)} ${describeFileError(entry.error)}.\n${entry.error.message}`
      : `${entry.data.title ? `${entry.data.title}\n` : ''}${pair}\n${countsLabel(entry.counts)}\n${tildify(entry.filePath)}`;
    tree.iconPath = entry.error ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')) : icon(entry.counts);
    tree.contextValue = 'review';
    tree.command = { command: 'prereview.switchReview', title: 'Open Review', arguments: [entry] };
    return tree;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.dispose();
    this.changed.dispose();
  }
}

// Whose move it is in a review
function turn(counts: Record<ThreadStatus, number>): string | undefined {
  if (counts.awaitingYou) return `your turn · ${counts.awaitingYou} waiting`;
  if (counts.awaitingAgent) return "agent's turn";
  if (counts.resolved) return 'all resolved';
  return undefined;
}
