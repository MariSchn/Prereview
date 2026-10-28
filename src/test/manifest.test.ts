import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { AGENT_PROMPT, REVIEW_AGENT_PROMPT } from '../model';

const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs
  .readdirSync(path.join(root, 'src'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => fs.readFileSync(path.join(root, 'src', name), 'utf8'))
  .join('\n');
const declared = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
const menuItems: { command: string; when?: string }[] = Object.values(pkg.contributes.menus).flat() as any;
const builtIn = new Set(['editor.action.insertSnippet', 'vscode.openFolder', 'git.init']);

test('every command the manifest uses is declared, and every declared command is registered', () => {
  const registered = new Set([...source.matchAll(/command\('(prereview\.\w+)'/g)].map((m) => m[1]));
  assert.deepStrictEqual([...declared].filter((c) => !registered.has(c)), []);
  assert.deepStrictEqual([...registered].filter((c) => !declared.has(c)), []);
  const links = pkg.contributes.viewsWelcome.flatMap((w: { contents: string }) => [...w.contents.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1]));
  const used = [...menuItems.map((m) => m.command), ...pkg.contributes.keybindings.map((k: { command: string }) => k.command), ...links];
  assert.deepStrictEqual(used.filter((c) => !declared.has(c) && !builtIn.has(c)), []);
});

test('every Prereview context key a when clause reads is set by the extension', () => {
  const whens = [...menuItems, ...pkg.contributes.keybindings, ...pkg.contributes.viewsWelcome].map((m) => m.when ?? '');
  const views = new Set(Object.values(pkg.contributes.views).flat().map((v: any) => v.id));
  const keys = new Set(whens.flatMap((w) => [...w.matchAll(/\bprereview\.\w+/g)].map((m) => m[0])).filter((k) => !views.has(k)));
  const set = new Set([...source.matchAll(/setContext'?[,(]\s*'(prereview\.\w+)'/g)].map((m) => m[1]));
  assert.ok(set.size > 5, 'found where context keys are set');
  assert.deepStrictEqual([...keys].filter((k) => !set.has(k)), []);
});

test('the prompt settings default to the prompts the extension falls back to', () => {
  const settings = pkg.contributes.configuration.properties;
  assert.deepStrictEqual([settings['prereview.agentPrompt'].default, settings['prereview.reviewAgentPrompt'].default], [AGENT_PROMPT, REVIEW_AGENT_PROMPT]);
});
