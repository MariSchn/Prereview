import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewData, ThreadStatus, countStatuses, pairLabel, parseReview } from './model';

export interface ReviewEntry {
  filePath: string;
  data: ReviewData;
  counts: Record<ThreadStatus, number>;
}

export async function listReviews(root: string): Promise<ReviewEntry[]> {
  const dir = path.join(root, '.prereview');
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const entries: ReviewEntry[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const filePath = path.join(dir, name);
    try {
      const data = parseReview(await fs.readFile(filePath, 'utf8'));
      entries.push({ filePath, data, counts: countStatuses(data.threads) });
    } catch {
      continue;
    }
  }
  return entries;
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

export class ReviewsView implements vscode.TreeDataProvider<ReviewEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private watcher?: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private version = 0;
  private root?: string;
  entries: ReviewEntry[] = [];
  active?: string;

  setRoot(root: string): void {
    this.root = root;
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.prereview/*.json'));
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), 300);
    };
    this.watcher.onDidChange(schedule);
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidDelete(schedule);
    void this.refresh();
  }

  setActive(filePath: string | undefined): void {
    this.active = filePath;
    this.changed.fire();
  }

  async refresh(): Promise<void> {
    const version = ++this.version;
    const entries = this.root ? await listReviews(this.root) : [];
    if (version !== this.version) return;
    this.entries = entries;
    this.changed.fire();
  }

  getChildren(entry?: ReviewEntry): ReviewEntry[] {
    return entry ? [] : this.entries;
  }

  getTreeItem(entry: ReviewEntry): vscode.TreeItem {
    const pair = pairLabel(entry.data);
    const active = entry.filePath === this.active;
    const item = new vscode.TreeItem(entry.data.title || pair);
    item.id = entry.filePath;
    item.description = [active && 'active', entry.data.title && pair, entry.counts.awaitingYou && `${entry.counts.awaitingYou} awaiting you`]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = `${entry.data.title ? `${entry.data.title}\n` : ''}${pair}\n${countsLabel(entry.counts)}`;
    item.iconPath = icon(entry.counts);
    item.contextValue = 'review';
    item.command = { command: 'prereview.switchReview', title: 'Open Review', arguments: [entry] };
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.dispose();
    this.changed.dispose();
  }
}
