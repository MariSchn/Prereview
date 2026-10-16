import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile } from './git';
import { Review } from './review';

const STATUS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' };

export class FilesView implements vscode.TreeDataProvider<ChangedFile> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  review?: Review;

  refresh(): void {
    this.changed.fire();
  }

  getChildren(): ChangedFile[] {
    return this.review?.files ?? [];
  }

  getTreeItem(file: ChangedFile): vscode.TreeItem {
    const review = this.review!;
    const item = new vscode.TreeItem(path.posix.basename(file.path));
    const dir = path.posix.dirname(file.path);
    const open = review.data.threads.filter((t) => t.file === file.path && !t.resolved).length;
    item.description = [dir === '.' ? '' : dir, file.status, open ? `${open} open` : ''].filter(Boolean).join(' · ');
    item.tooltip = `${file.path} (${STATUS[file.status]}${file.status === 'R' ? ` from ${file.oldPath}` : ''})`;
    item.resourceUri = vscode.Uri.file(path.join(review.root, file.path));
    item.command = { command: 'prereview.openDiff', title: 'Open Diff', arguments: [file] };
    return item;
  }
}
