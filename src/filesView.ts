import * as path from 'path';
import * as vscode from 'vscode';
import { FileNode, TreeNode, buildTree, flatten } from './fileTree';
import { ChangedFile, Status } from './git';
import { Review } from './review';

export const DECORATION_SCHEME = 'prereview-file';

const STATUS: Record<Status, [label: string, color: string]> = {
  A: ['Added', 'gitDecoration.addedResourceForeground'],
  M: ['Modified', 'gitDecoration.modifiedResourceForeground'],
  D: ['Deleted', 'gitDecoration.deletedResourceForeground'],
  R: ['Renamed', 'gitDecoration.renamedResourceForeground'],
};

export type FileItem = FileNode<ChangedFile>;

export class FilesView implements vscode.TreeDataProvider<TreeNode<ChangedFile>>, vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: TreeNode<ChangedFile>[] = [];
  private parents = new Map<TreeNode<ChangedFile>, TreeNode<ChangedFile>>();
  private nodes = new Map<string, FileItem>();
  review?: Review;

  refresh(): void {
    this.roots = this.review ? buildTree(this.review.files) : [];
    this.parents.clear();
    this.nodes.clear();
    const index = (nodes: TreeNode<ChangedFile>[], parent?: TreeNode<ChangedFile>) => {
      for (const node of nodes) {
        if (parent) this.parents.set(node, parent);
        if (node.kind === 'file') this.nodes.set(node.file.path, node);
        else index(node.children, node);
      }
    };
    index(this.roots);
    this.changed.fire();
  }

  nodeOf(file: string): FileItem | undefined {
    return this.nodes.get(file);
  }

  getParent(node: TreeNode<ChangedFile>): TreeNode<ChangedFile> | undefined {
    return this.parents.get(node);
  }

  get orderedFiles(): ChangedFile[] {
    return flatten(this.roots);
  }

  getChildren(node?: TreeNode<ChangedFile>): TreeNode<ChangedFile>[] {
    if (!node) return this.roots;
    return node.kind === 'folder' ? node.children : [];
  }

  getTreeItem(node: TreeNode<ChangedFile>): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.path}`;
      item.resourceUri = vscode.Uri.from({ scheme: DECORATION_SCHEME, path: '/' + node.path });
      item.iconPath = vscode.ThemeIcon.Folder;
      const viewed = flatten(node.children).every((f) => this.review!.viewState(f) === 'viewed');
      item.checkboxState = {
        state: viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
        tooltip: viewed ? 'Mark folder as not viewed' : 'Mark folder as viewed',
      };
      return item;
    }
    const review = this.review!;
    const file = node.file;
    const state = review.viewState(file);
    const open = review.data.threads.filter((t) => t.file === file.path && !t.resolved).length;
    const stats = file.added === undefined ? 'binary' : `+${file.added} −${file.deleted}`;
    const item = new vscode.TreeItem(path.posix.basename(file.path));
    item.id = `file:${file.path}`;
    item.resourceUri = vscode.Uri.from({ scheme: DECORATION_SCHEME, path: '/' + file.path, query: file.status });
    item.description = [state === 'updated' ? 'changed since viewed' : '', stats, open ? `${open} open` : ''].filter(Boolean).join(' · ');
    item.tooltip = [
      `${file.path} (${STATUS[file.status][0]}${file.status === 'R' ? ` from ${file.oldPath}` : ''})`,
      open ? `${open} open thread${open === 1 ? '' : 's'}` : '',
      state === 'updated' ? 'Changed since you marked it as viewed' : '',
    ]
      .filter(Boolean)
      .join('\n');
    item.checkboxState = state === 'viewed' ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    item.contextValue = file.status === 'D' ? 'file-deleted' : state === 'updated' ? 'file-updated' : 'file';
    item.command = { command: 'prereview.openDiff', title: 'Open Diff', arguments: [node] };
    return item;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME || !(uri.query in STATUS)) return undefined;
    const [label, color] = STATUS[uri.query as Status];
    return { badge: uri.query, color: new vscode.ThemeColor(color), tooltip: label };
  }
}
