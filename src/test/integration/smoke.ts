// Runs inside VS Code, started by runTests.ts, against its one-file repository.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from '../../controller';
import { Review, createReview } from '../../review';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
let controller: Controller;
let review: Review;

const tests: [string, () => Promise<void>][] = [
  [
    'activates and registers every command in the manifest',
    async () => {
      const extension = vscode.extensions.getExtension('marischn.prereview')!;
      controller = await extension.activate();
      const commands = await vscode.commands.getCommands(true);
      const missing = extension.packageJSON.contributes.commands.map((c: { command: string }) => c.command).filter((c: string) => !commands.includes(c));
      assert.deepStrictEqual(missing, []);
    },
  ],
  [
    'opens a review of the working tree and shows the base version of a file',
    async () => {
      review = (await controller.open(await createReview(root(), 'main', null)))!;
      assert.deepStrictEqual(review.files.map((f) => [f.path, f.status, f.added]), [['a.ts', 'M', 1]]);
      const base = await vscode.workspace.openTextDocument(review.baseUri('a.ts'));
      assert.strictEqual(base.getText(), 'one\ntwo\n');
    },
  ],
  [
    'opens the diff of a changed file',
    async () => {
      await vscode.commands.executeCommand('prereview.openDiff', review.files[0]);
      await sleep(300);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'the active tab is a diff');
      assert.strictEqual((tab.input as vscode.TabInputTextDiff).modified.fsPath, path.join(root(), 'a.ts'));
    },
  ],
  [
    'marks a file as viewed',
    async () => {
      await vscode.commands.executeCommand('prereview.markViewed', review.files[0]);
      assert.strictEqual(review.viewState(review.files[0]), 'viewed');
    },
  ],
  [
    'moves a thread while lines are added above it, before the file is saved',
    async () => {
      await review.addThread({ file: 'a.ts', startLine: 3, endLine: 3 }, 'Why three?');
      const doc = await vscode.workspace.openTextDocument(path.join(root(), 'a.ts'));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), 'zero\nhalf\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      await sleep(600);
      assert.deepStrictEqual(review.position(review.data.threads[0]), { start: 5, end: 5, outdated: false });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    },
  ],
  [
    'opens the overview',
    async () => {
      await vscode.commands.executeCommand('prereview.openOverview');
      await sleep(300);
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      assert.ok(tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('prereview.overview')));
    },
  ],
];

export async function run(): Promise<void> {
  const failed: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`✔ ${name}`);
    } catch (e) {
      console.error(`✖ ${name}\n${(e as Error).stack}`);
      failed.push(name);
    }
  }
  if (failed.length) throw new Error(`${failed.length} smoke test(s) failed: ${failed.join('; ')}`);
}
