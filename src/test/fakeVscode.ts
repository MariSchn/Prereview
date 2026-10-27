// A stand-in for the parts of the `vscode` module that `Review` and `listReviews` use, so they run under node.
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

export const comments = {
  createCommentController: () => ({
    commentingRangeProvider: undefined as unknown,
    createCommentThread: (uri: Uri, range: Range | undefined, comments: unknown[]) => {
      const thread = new FakeCommentThread(uri, range, comments);
      commentThreads.push(thread);
      return thread;
    },
    dispose() {},
  }),
};

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
const never = () => ({ dispose() {} });
const watchers = new Set<{ base: string; fire: (uri: Uri) => void }>();

export const workspace = {
  textDocuments: [] as FakeDocument[],
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
  onDidChangeVisibleTextEditors: never,
  onDidChangeTextEditorSelection: never,
  visibleTextEditors: [] as unknown[],
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
