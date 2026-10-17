import * as assert from 'assert';
import { test } from 'node:test';
import { TreeNode, buildTree, flatten } from '../fileTree';

const names = (nodes: TreeNode<{ path: string }>[]): unknown[] =>
  nodes.map((n) => (n.kind === 'file' ? n.file.path : { [n.name]: names(n.children) }));

test('buildTree nests folders, compacts single-folder chains and lists folders first', () => {
  const tree = buildTree([{ path: 'z.md' }, { path: 'src/a/b/x.ts' }, { path: 'src/a/b/y.ts' }, { path: 'src/c.ts' }, { path: 'docs/guide/intro.md' }]);
  assert.deepStrictEqual(names(tree), [
    { 'docs/guide': ['docs/guide/intro.md'] },
    { src: [{ 'a/b': ['src/a/b/x.ts', 'src/a/b/y.ts'] }, 'src/c.ts'] },
    'z.md',
  ]);
  assert.deepStrictEqual(
    flatten(tree).map((f) => f.path),
    ['docs/guide/intro.md', 'src/a/b/x.ts', 'src/a/b/y.ts', 'src/c.ts', 'z.md'],
  );
});
