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
  get fsPath(): string {
    return this.path.split('/').join(path.sep);
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

export const workspace = {
  textDocuments: [] as FakeDocument[],
  createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
  onDidChangeTextDocument: changeDocument.event,
  onDidCloseTextDocument: closeDocument.event,
};

export const warnings: string[] = [];

export const window = {
  showWarningMessage: (message: string) => {
    warnings.push(message);
    return Promise.resolve(undefined);
  },
};

// Test helpers
export function editDocument(document: FakeDocument): void {
  changeDocument.fire({ document, contentChanges: [{}] });
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
