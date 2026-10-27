export interface FolderNode<T> {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeNode<T>[];
}

export interface FileNode<T> {
  kind: 'file';
  file: T;
}

export type TreeNode<T> = FolderNode<T> | FileNode<T>;

export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T>[] {
  const root: FolderNode<T> = { kind: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    let folder = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      const folderPath = folder.path ? `${folder.path}/${part}` : part;
      let child = folder.children.find((c): c is FolderNode<T> => c.kind === 'folder' && c.path === folderPath);
      if (!child) {
        child = { kind: 'folder', name: part, path: folderPath, children: [] };
        folder.children.push(child);
      }
      folder = child;
    }
    folder.children.push({ kind: 'file', file });
  }
  return sort(root.children.map(compact));
}

// Files in tree order, with lock files and generated files at the end
export function orderFiles<T extends { path: string; generated?: boolean }>(files: T[]): T[] {
  return [...flatten(buildTree(files.filter((f) => !f.generated))), ...files.filter((f) => f.generated).sort((a, b) => a.path.localeCompare(b.path))];
}

export function flatten<T>(nodes: TreeNode<T>[]): T[] {
  return nodes.flatMap((n) => (n.kind === 'file' ? [n.file] : flatten(n.children)));
}

function compact<T extends { path: string }>(node: TreeNode<T>): TreeNode<T> {
  if (node.kind === 'file') return node;
  let folder = node;
  while (folder.children.length === 1 && folder.children[0].kind === 'folder') {
    const child = folder.children[0];
    folder = { kind: 'folder', name: `${folder.name}/${child.name}`, path: child.path, children: child.children };
  }
  return { ...folder, children: sort(folder.children.map(compact)) };
}

function sort<T extends { path: string }>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  const key = (n: TreeNode<T>) => (n.kind === 'folder' ? n.path : n.file.path);
  return nodes.sort((a, b) => (a.kind === b.kind ? key(a).localeCompare(key(b)) : a.kind === 'folder' ? -1 : 1));
}
