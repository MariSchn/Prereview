// Runs the smoke tests in a real VS Code, on a throwaway repository with one changed file.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-it-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'one\ntwo\nthree\n');
  try {
    await runTests({
      // The oldest VS Code the extension supports
      version: process.env.VSCODE_VERSION ?? '1.99.3',
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..', '..'),
      extensionTestsPath: path.resolve(__dirname, 'smoke'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
