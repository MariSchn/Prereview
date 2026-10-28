// A stand-in for the parts of the `vscode` module that `Review` and `listReviews` use, so they run under node.
import * as fs from 'fs';
import * as path from 'path';

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  readonly event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const listener of [...this.listeners]) listener(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query: string,
  ) {}
  static file(fsPath: string): Uri {
    return new Uri('file', fsPath.split(path.sep).join('/'), '');
  }
  static from(parts: { scheme: string; path?: string; query?: string }): Uri {
    return new Uri(parts.scheme, parts.path ?? '', parts.query ?? '');
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, path.posix.join(base.path, ...parts), base.query);
  }
  // Like VS Code, with a Windows drive letter in lower case
  get fsPath(): string {
    const fsPath = this.path.split('/').join(path.sep);
    return /^[A-Za-z]:/.test(fsPath) ? fsPath[0].toLowerCase() + fsPath.slice(1) : fsPath;
  }
  toString(): string {
    return `${this.scheme}://${this.path}${this.query ? `?${encodeURIComponent(this.query)}` : ''}`;
  }
}

export class RelativePattern {
  constructor(
    readonly base: string,
    readonly pattern: string,
  ) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

export class MarkdownString {
  isTrusted?: unknown;
  constructor(readonly value = '') {}
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

export enum CommentMode {
  Editing = 0,
  Preview = 1,
}

export enum CommentThreadState {
  Unresolved = 0,
  Resolved = 1,
}

export enum CommentThreadCollapsibleState {
  Collapsed = 0,
  Expanded = 1,
}

// Counts how often the extension hands a thread its comments, which makes VS Code redraw it
export class FakeCommentThread {
  commentUpdates = 0;
  disposed = false;
  state?: CommentThreadState;
  collapsibleState?: CommentThreadCollapsibleState;
  contextValue?: string;
  label?: string;
  private current: unknown[];
  constructor(
    readonly uri: Uri,
    public range: Range | undefined,
    comments: unknown[],
  ) {
    this.current = comments;
  }
  get comments(): any[] {
    return this.current;
  }
  set comments(comments: any[]) {
    this.current = comments;
    this.commentUpdates++;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export const commentThreads: FakeCommentThread[] = [];

// Counts how often the commenting ranges are set, which makes VS Code rebuild every comment widget
export class FakeCommentController {
  rangeUpdates = 0;
  private provider: any;
  get commentingRangeProvider(): any {
    return this.provider;
  }
  set commentingRangeProvider(provider: any) {
    this.provider = provider;
    this.rangeUpdates++;
  }
  createCommentThread(uri: Uri, range: Range | undefined, comments: unknown[]): FakeCommentThread {
    const thread = new FakeCommentThread(uri, range, comments);
    commentThreads.push(thread);
    return thread;
  }
  dispose(): void {}
}

export const commentControllers: FakeCommentController[] = [];

export const comments = {
  createCommentController: () => {
    const controller = new FakeCommentController();
    commentControllers.push(controller);
    return controller;
  },
};

export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
  ) {}
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  constructor(readonly label: string) {}
}

export interface FakeDocument {
  uri: Uri;
  isDirty: boolean;
  getText(): string;
}

const changeDocument = new EventEmitter<{ document: FakeDocument; contentChanges: unknown[] }>();
const closeDocument = new EventEmitter<FakeDocument>();
const changeWindowState = new EventEmitter<{ focused: boolean }>();
const changeVisibleEditors = new EventEmitter<unknown[]>();
const changeTabs = new EventEmitter<unknown>();
const never = () => ({ dispose() {} });
const watchers = new Set<{ base: string; fire: (uri: Uri) => void }>();

// A document over a file on disk, enough to apply edits to it and save it
class TextDocument {
  isDirty = false;
  constructor(
    readonly uri: Uri,
    private text: string,
  ) {}
  get lineCount(): number {
    return this.text.split('\n').length;
  }
  lineAt(line: number) {
    const text = this.text.split('\n')[line];
    return { text, range: new Range(line, 0, line, text.length) };
  }
  getText(): string {
    return this.text;
  }
  replace(range: Range, text: string): void {
    const offset = (p: Position) => this.text.split('\n').slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    this.text = this.text.slice(0, offset(range.start)) + text + this.text.slice(offset(range.end));
    this.isDirty = true;
  }
  async save(): Promise<boolean> {
    fs.writeFileSync(this.uri.fsPath, this.text);
    this.isDirty = false;
    return true;
  }
}

export class WorkspaceEdit {
  readonly edits: { uri: Uri; range: Range; text: string }[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.edits.push({ uri, range, text });
  }
}

export const workspace = {
  textDocuments: [] as FakeDocument[],
  getConfiguration: () => ({ get: () => undefined }),
  openTextDocument: async (uri: Uri) => {
    const open = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open;
    const doc = new TextDocument(uri, fs.readFileSync(uri.fsPath, 'utf8'));
    workspace.textDocuments.push(doc);
    return doc;
  },
  applyEdit: async (edit: WorkspaceEdit) => {
    for (const { uri, range, text } of edit.edits) ((await workspace.openTextDocument(uri)) as TextDocument).replace(range, text);
    return true;
  },
  createFileSystemWatcher: (pattern: RelativePattern) => {
    const listeners: ((uri: Uri) => void)[] = [];
    const listen = (listener: (uri: Uri) => void) => listeners.push(listener);
    const watcher = { base: pattern.base, fire: (uri: Uri) => listeners.forEach((l) => l(uri)) };
    watchers.add(watcher);
    return { onDidChange: listen, onDidCreate: listen, onDidDelete: listen, dispose: () => watchers.delete(watcher) };
  },
  onDidChangeTextDocument: changeDocument.event,
  onDidCloseTextDocument: closeDocument.event,
};

export const warnings: string[] = [];

export const window = {
  state: { focused: true },
  onDidChangeWindowState: changeWindowState.event,
  activeColorTheme: { kind: ColorThemeKind.Dark },
  onDidChangeActiveColorTheme: never,
  onDidChangeVisibleTextEditors: changeVisibleEditors.event,
  onDidChangeTextEditorSelection: never,
  visibleTextEditors: [] as unknown[],
  tabGroups: { all: [] as { activeTab?: { input: unknown } }[], onDidChangeTabs: changeTabs.event, onDidChangeTabGroups: never },
  createTextEditorDecorationType: () => ({ dispose() {} }),
  showWarningMessage: (message: string) => {
    warnings.push(message);
    return Promise.resolve(undefined);
  },
};

// Test helpers
export function editDocument(document: FakeDocument): void {
  changeDocument.fire({ document, contentChanges: [{}] });
}

// Reports a change to a file to every watcher whose folder holds it
export function touch(fsPath: string): void {
  for (const watcher of watchers) {
    if (!path.relative(watcher.base, fsPath).startsWith('..')) watcher.fire(Uri.file(fsPath));
  }
}

// Shows a tab in each of as many groups as there are inputs
export function showTabs(...inputs: unknown[]): void {
  window.tabGroups.all = inputs.map((input) => ({ activeTab: { input } }));
  changeTabs.fire({});
}

// Shows editors on these documents. VS Code reports the text box of each comment widget as an editor too.
export function showEditors(...uris: Uri[]): void {
  window.visibleTextEditors = uris.map((uri) => ({ document: { uri }, selection: new Range(0, 0, 0, 0), setDecorations() {} }));
  changeVisibleEditors.fire(window.visibleTextEditors);
}

export function setFocused(focused: boolean): void {
  window.state = { focused };
  changeWindowState.fire({ focused });
}

export class Memento {
  private readonly values = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
}
