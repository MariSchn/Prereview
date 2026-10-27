import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const REVIEWER = 'reviewer';

export function authorName(author: string): string {
  if (author === REVIEWER) return 'You';
  const name = author || 'agent';
  return name[0].toUpperCase() + name.slice(1);
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt?: string;
}

export interface Thread {
  id: string;
  file?: string;
  side?: 'base';
  startLine?: number;
  endLine?: number;
  snippet?: string;
  resolved: boolean;
  comments: Comment[];
  // Comments in the file that could not be read, for example without a `body`
  unreadable?: number;
}

export interface ReviewData {
  title: string;
  description: string;
  base: string;
  target: string | null;
  threads: Thread[];
  // Entries in `threads` that could not be read
  unreadable?: number;
}

export type ThreadStatus = 'awaitingYou' | 'awaitingAgent' | 'resolved';

export const STATUS_LABELS: Record<ThreadStatus, string> = {
  awaitingYou: 'Awaiting you',
  awaitingAgent: 'Awaiting agent',
  resolved: 'Resolved',
};

export const AGENT_INSTRUCTIONS =
  'This file is a local code review left with Prereview, the local equivalent of a GitHub pull request. ' +
  '`base` is the branch the changes are compared against; `target` is the branch under review, or null for the uncommitted working tree. ' +
  'If `title` or `description` is empty, fill it in like a pull request: a short title and a markdown description of what changed and why. ' +
  'Each entry in `threads` is a conversation. A thread with `file` (relative to the repository root, with forward slashes) and `startLine`/`endLine` (1-based) is about those lines and `snippet` is the code it was left on; ' +
  'without lines it is about the whole file, and without `file` it is about the change as a whole. `"side": "base"` means the lines are in the old version of the file. ' +
  'Prereview keeps `startLine`/`endLine` up to date as the code moves. ' +
  'For every thread with `resolved: false` whose last comment is the reviewer\'s, address the feedback in the code (or decide not to), then append a reply to its `comments`: ' +
  '{"author": "agent", "body": "<what you changed, or why not>"}. If something is unclear, ask in a reply instead. ' +
  'You may also open a thread to point the reviewer to something or ask a question by appending ' +
  '{"id": "<unique id>", "file": "<path>", "startLine": <n>, "endLine": <n>, "resolved": false, "comments": [{"author": "agent", "body": "..."}]} to `threads` ' +
  '(leave out the lines for a whole-file comment, or `file` for a general one). ' +
  'Prereview gives every comment an `id`; you can leave it out of the comments you add. ' +
  'Do not resolve threads or edit or delete existing comments; the reviewer does that. ' +
  'Make your changes where `target` is checked out, or commit them to it. ' +
  'Read this file again right before you edit it, since the reviewer may have added comments in the meantime, and keep it valid JSON; ' +
  'the reviewer\'s editor picks up changes automatically.';

export function threadStatus(thread: Thread): ThreadStatus {
  if (thread.resolved) return 'resolved';
  return thread.comments[thread.comments.length - 1]?.author === REVIEWER ? 'awaitingAgent' : 'awaitingYou';
}

export function countStatuses(threads: Thread[]): Record<ThreadStatus, number> {
  const counts: Record<ThreadStatus, number> = { awaitingYou: 0, awaitingAgent: 0, resolved: 0 };
  for (const t of threads) counts[threadStatus(t)]++;
  return counts;
}

export function pairLabel(data: ReviewData): string {
  return `${data.base} ↔ ${data.target ?? 'working tree'}`;
}

// A review as Markdown, to keep after finishing it or paste into a pull request
export function reviewMarkdown(data: ReviewData, lines: (thread: Thread) => Span | undefined): string {
  const out = [`# ${data.title || pairLabel(data)}`, ''];
  if (data.title) out.push(pairLabel(data), '');
  if (data.description) out.push(data.description, '');
  for (const t of data.threads) {
    const span = lines(t);
    const at = span && (span.start === span.end ? `:${span.start}` : `:${span.start}-${span.end}`);
    const where = t.file ? `\`${t.file}${at ?? ''}\`${t.side === 'base' ? ' (old version)' : ''}` : 'General comment';
    out.push(`## ${where} · ${STATUS_LABELS[threadStatus(t)]}`, '');
    if (t.snippet !== undefined && t.file) {
      const fence = '`'.repeat(Math.max(3, ...(t.snippet.match(/`+/g) ?? []).map((run) => run.length + 1)));
      out.push(`${fence}${path.posix.extname(t.file).slice(1)}`, t.snippet, fence, '');
    }
    for (const c of t.comments) out.push(`**${authorName(c.author)}:**`, '', c.body, '');
  }
  return out.join('\n').trimEnd() + '\n';
}

// A path with the home folder shortened to ~
export function tildify(dir: string): string {
  const home = os.homedir();
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

export function reviewFileName(base: string, target: string | null): string {
  const slug = (s: string) => s.replace(/[^\w.-]+/g, '-');
  return `${slug(base)}...${slug(target ?? 'worktree')}.json`;
}

export async function reviewFilePath(root: string, base: string, target: string | null): Promise<string> {
  const name = reviewFileName(base, target);
  const dir = path.join(root, '.prereview');
  for (let n = 1; ; n++) {
    const filePath = path.join(dir, n === 1 ? name : name.replace(/\.json$/, `-${n}.json`));
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return filePath;
    }
    // A file that can't be read may be this review mid-edit; starting a second one next to it would split the comments.
    const pair = readPair(text);
    if (!pair) throw new Error(`${path.basename(filePath)} can't be read. Fix or delete it, then start the review again.`);
    if (pair.base === base && pair.target === target) return filePath;
  }
}

// The base and target a review file compares, even when the rest of it is not valid JSON.
export function readPair(text: string): { base: string; target: string | null } | undefined {
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    return typeof raw?.base === 'string' ? { base: raw.base, target: typeof raw.target === 'string' ? raw.target : null } : undefined;
  } catch {
    const base = /"base"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
    const target = /"target"\s*:\s*(null|"(?:[^"\\]|\\.)*")/.exec(text)?.[1];
    if (!base || !target) return undefined;
    try {
      return { base: JSON.parse(base), target: JSON.parse(target) };
    } catch {
      return undefined;
    }
  }
}

export interface FileError {
  message: string;
  line?: number;
  column?: number;
}

export function fileError(e: Error, text: string): FileError {
  if (!(e instanceof SyntaxError)) return { message: e.message };
  const lines = text.slice(0, syntaxErrorAt(text)).split('\n');
  return { message: e.message, line: lines.length, column: lines[lines.length - 1].length + 1 };
}

const LITERAL = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null/y;

// Where a text stops being valid JSON; JSON.parse doesn't always say
function syntaxErrorAt(text: string): number {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const space = () => {
    while (/\s/.test(text[i] ?? '')) i++;
  };
  const expect = (c: string) => {
    space();
    if (text[i] !== c) throw i;
    i++;
  };
  const string = () => {
    expect('"');
    for (; text[i] !== '"'; i++) {
      if (i >= text.length || text.charCodeAt(i) < 0x20) throw i;
      if (text[i] === '\\') i++;
    }
    i++;
  };
  const list = (close: string, item: () => void) => {
    space();
    if (text[i] === close) return void i++;
    for (;;) {
      item();
      space();
      if (text[i] === close) return void i++;
      expect(',');
    }
  };
  const value = (): void => {
    space();
    if (text[i] === '{') {
      i++;
      return list('}', () => {
        string();
        expect(':');
        value();
      });
    }
    if (text[i] === '[') {
      i++;
      return list(']', value);
    }
    if (text[i] === '"') return string();
    LITERAL.lastIndex = i;
    if (!LITERAL.exec(text)) throw i;
    i = LITERAL.lastIndex;
  };
  try {
    value();
    space();
    return i < text.length ? i : text.length;
  } catch (at) {
    return at as number;
  }
}

export function describeFileError(error: FileError): string {
  if (error.line === undefined) return `can't be read (${error.message.replace(/^missing/, 'it is missing')})`;
  return `isn't valid JSON (line ${error.line}, column ${error.column})`;
}

export function parseReview(text: string, options?: ReadOptions): ReviewData {
  return new ReviewDocument(text, options).data;
}

export interface ReadOptions {
  // Absolute paths inside these folders become repository-relative, tried in order
  roots?: string[];
}

// Agents don't always use the documented key for a comment's text.
const BODY_KEYS = ['body', 'text', 'message', 'content'];

// A review file as read from disk. Edits change only the entries they touch, and everything Prereview
// doesn't understand, such as unknown fields or comments it can't read, is written back as it was.
export class ReviewDocument {
  readonly data: ReviewData;
  private readonly raw: any;
  private readonly threads = new Map<string, any>();
  private readonly comments = new Map<string, any>();
  // The id and repository-relative path Prereview read from each entry, written back so they stay stable
  private readonly read = new Map<object, { id: string; file?: string }>();

  constructor(text: string, options: ReadOptions = {}) {
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (typeof raw?.base !== 'string') throw new Error('missing "base"');
    this.raw = raw;
    const threads: Thread[] = [];
    let unreadable = 0;
    for (const t of Array.isArray(raw.threads) ? raw.threads : []) {
      const entries: any[] = Array.isArray(t?.comments) ? t.comments : [];
      const bodies = entries.map(commentBody);
      const first = bodies.find((body) => body !== undefined);
      if (first === undefined) {
        unreadable++;
        continue;
      }
      const file = typeof t.file === 'string' && t.file ? repoPath(t.file, options.roots) : undefined;
      const startLine = file ? lineNumber(t.startLine) : undefined;
      let id = typeof t.id === 'string' && t.id ? t.id : hashId(`${file}:${startLine}:${first}`);
      if (this.threads.has(id)) id = `${id}-${threads.length}`;
      this.threads.set(id, t);
      this.read.set(t, { id, file });
      const comments: Comment[] = [];
      entries.forEach((c, i) => {
        const body = bodies[i];
        if (body === undefined) return;
        let commentId = typeof c.id === 'string' && c.id ? c.id : hashId(`${id}:${i}:${body}`);
        if (this.comments.has(commentKey(id, commentId))) commentId = `${commentId}-${i}`;
        this.comments.set(commentKey(id, commentId), c);
        this.read.set(c, { id: commentId });
        comments.push({
          id: commentId,
          author: typeof c.author === 'string' ? c.author : 'agent',
          body,
          createdAt: typeof c.createdAt === 'string' ? c.createdAt : undefined,
        });
      });
      threads.push({
        id,
        file,
        side: file && t.side === 'base' ? 'base' : undefined,
        startLine,
        endLine: startLine === undefined ? undefined : Math.max(lineNumber(t.endLine) ?? startLine, startLine),
        snippet: startLine !== undefined && typeof t.snippet === 'string' ? t.snippet : undefined,
        resolved: t.resolved === true,
        comments,
        ...(comments.length < entries.length ? { unreadable: entries.length - comments.length } : {}),
      });
    }
    this.data = {
      title: typeof raw.title === 'string' ? raw.title : '',
      description: typeof raw.description === 'string' ? raw.description : '',
      base: raw.base,
      target: typeof raw.target === 'string' ? raw.target : null,
      threads,
      ...(unreadable ? { unreadable } : {}),
    };
  }

  addThread(location: Pick<Thread, 'file' | 'side' | 'startLine' | 'endLine' | 'snippet'>, comment: Comment): void {
    const { file, side, startLine, endLine, snippet } = location;
    if (!Array.isArray(this.raw.threads)) this.raw.threads = [];
    this.raw.threads.push({ id: newId(), file, side, startLine, endLine, snippet, resolved: false, comments: [comment] });
  }

  addComment(threadId: string, comment: Comment): void {
    const t = this.thread(threadId);
    if (!Array.isArray(t.comments)) t.comments = [];
    t.comments.push(comment);
  }

  setResolved(threadId: string, resolved: boolean): void {
    this.thread(threadId).resolved = resolved;
  }

  editComment(threadId: string, commentId: string, body: string): void {
    const c = this.comment(threadId, commentId);
    if (typeof c.body !== 'string') for (const key of BODY_KEYS) delete c[key];
    c.body = body;
  }

  deleteComment(threadId: string, commentId: string): void {
    const t = this.thread(threadId);
    t.comments.splice(t.comments.indexOf(this.comment(threadId, commentId)), 1);
    this.comments.delete(commentKey(threadId, commentId));
    if (t.comments.length) return;
    this.raw.threads.splice(this.raw.threads.indexOf(t), 1);
    this.threads.delete(threadId);
  }

  setLines(threadId: string, startLine: number, endLine: number): void {
    const t = this.thread(threadId);
    t.startLine = startLine;
    t.endLine = endLine;
  }

  setSnippet(threadId: string, snippet: string): void {
    this.thread(threadId).snippet = snippet;
  }

  toString(): string {
    const { agentInstructions, title, description, base, target, threads, ...rest } = this.raw;
    const out = {
      agentInstructions: AGENT_INSTRUCTIONS,
      title: typeof title === 'string' ? title : '',
      description: typeof description === 'string' ? description : '',
      base,
      target: typeof target === 'string' ? target : null,
      threads: Array.isArray(threads) ? threads.map((t: any) => this.written(t)) : (threads ?? []),
      ...rest,
    };
    return JSON.stringify(out, null, 2) + '\n';
  }

  private written(t: any): any {
    const read = this.read.get(t);
    if (!read) return t;
    const { id, ...rest } = t;
    const out = { id: read.id, ...rest };
    if (read.file !== undefined) out.file = read.file;
    if (Array.isArray(t.comments)) out.comments = t.comments.map((c: any) => this.writtenComment(c));
    return out;
  }

  private writtenComment(c: any): any {
    const read = this.read.get(c);
    if (!read) return c;
    const { id, ...rest } = c;
    if (typeof rest.body !== 'string') {
      const key = BODY_KEYS.find((k) => typeof rest[k] === 'string')!;
      rest.body = rest[key];
      delete rest[key];
    }
    return { id: read.id, ...rest };
  }

  private thread(id: string): any {
    const t = this.threads.get(id);
    if (!t) throw new Error('This thread is no longer in the review file.');
    return t;
  }

  private comment(threadId: string, commentId: string): any {
    const c = this.comments.get(commentKey(threadId, commentId));
    if (!c) throw new Error('This comment is no longer in the review file.');
    return c;
  }
}

function commentKey(threadId: string, commentId: string): string {
  return `${threadId}\n${commentId}`;
}

function commentBody(c: any): string | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const key = BODY_KEYS.find((k) => typeof c[k] === 'string');
  return key && c[key];
}

function lineNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function repoPath(file: string, roots: string[] = []): string | undefined {
  if (path.isAbsolute(file) || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) {
    for (const root of roots) {
      const rel = path.relative(root, file);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    }
    return undefined;
  }
  const normal = path.posix.normalize(file.replace(/\\/g, '/'));
  if (/^\.\.?(\/|$)/.test(normal)) return undefined;
  return normal;
}

export function serializeReview(data: ReviewData): string {
  const { title, description, base, target } = data;
  const threads = data.threads.map(({ id, file, side, startLine, endLine, snippet, resolved, comments }) => ({
    id,
    file,
    side,
    startLine,
    endLine,
    snippet,
    resolved,
    comments: comments.map(({ id, author, body, createdAt }) => ({ id, author, body, createdAt })),
  }));
  return JSON.stringify({ agentInstructions: AGENT_INSTRUCTIONS, title, description, base, target, threads }, null, 2) + '\n';
}

export function newId(): string {
  return hashId(`${Date.now()}:${Math.random()}`);
}

function hashId(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

export interface Span {
  start: number;
  end: number;
}

// Lines around a thread used to tell identical copies of its code apart
const CONTEXT = 3;

export function matchesAt(lines: string[], start: number, text: string[]): boolean {
  return text.every((l, k) => lines[start - 1 + k]?.trimEnd() === l.trimEnd());
}

function occurrences(lines: string[], text: string[]): number[] {
  const starts: number[] = [];
  for (let s = 1; s + text.length - 1 <= lines.length; s++) if (matchesAt(lines, s, text)) starts.push(s);
  return starts;
}

// Finds a snippet when there is no earlier version of the file to follow it from: on its own line if it is still
// there, else the nearest copy. Several copies elsewhere make the result ambiguous.
export function locate(lines: string[], snippet: string, startLine: number): (Span & { ambiguous: boolean }) | undefined {
  const text = snippet.split('\n');
  const span = (s: number) => ({ start: s, end: s + text.length - 1 });
  if (matchesAt(lines, startLine, text)) return { ...span(startLine), ambiguous: false };
  const found = occurrences(lines, text);
  if (!found.length) return undefined;
  const nearest = found.reduce((best, s) => (Math.abs(s - startLine) < Math.abs(best - startLine) ? s : best));
  return { ...span(nearest), ambiguous: found.length > 1 };
}

// Beyond this many inserted and deleted lines between two versions, lines are no longer matched one by one
const DIFF_LIMIT = 1000;

// Which line of `after` each line of `before` is, for the lines that are unchanged, or -1. Lines are matched
// with Myers' diff on the part between the versions' common start and end; a part that changed too much to
// match within the limit counts as changed.
export function lineMap(before: string[], after: string[]): Int32Array {
  const n = before.length;
  const m = after.length;
  const map = new Int32Array(n).fill(-1);
  let top = 0;
  while (top < n && top < m && before[top] === after[top]) map[top] = top++;
  let bottom = 0;
  while (bottom < n - top && bottom < m - top && before[n - 1 - bottom] === after[m - 1 - bottom]) {
    map[n - 1 - bottom] = m - 1 - bottom;
    bottom++;
  }
  for (const [i, j] of diff(before.slice(top, n - bottom), after.slice(top, m - bottom)) ?? []) map[top + i] = top + j;
  return map;
}

// The pairs of equal lines in a shortest edit from `a` to `b`, or undefined past the limit
function diff(a: string[], b: string[]): [number, number][] | undefined {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  // v after each round d, for diagonals -d..d, to walk the edit back
  const trace: Int32Array[] = [];
  let rounds = -1;
  search: for (let d = 0; d <= Math.min(n + m, DIFF_LIMIT); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        rounds = d;
        break search;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (rounds < 0) return undefined;
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = rounds; d > 0; d--) {
    const previous = (k: number) => trace[d - 1][k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && previous(k - 1) < previous(k + 1));
    const from = down ? k + 1 : k - 1;
    const startX = down ? previous(from) : previous(from) + 1;
    while (x > startX && y > startX - k) pairs.push([--x, --y]);
    x = previous(from);
    y = x - from;
  }
  while (x > 0 && y > 0) pairs.push([--x, --y]);
  return pairs.reverse();
}

// Moves a span of lines from one version of a file to the next. Its lines, if unchanged, are found by diffing
// the two versions, so identical lines elsewhere can't be mistaken for them. If they changed, the span stays
// where its code was, after the last unchanged line above it, and is `lost`, unless the same lines were moved
// elsewhere: a copy among the new lines that is the only one, or the one whose neighbours match best.
export function follow(before: string[], after: string[], span: Span, snippet?: string[]): Span & { lost: boolean } {
  const map = lineMap(before, after);
  const first = span.start - 1;
  const last = Math.min(span.end, before.length) - 1;
  const lines = Array.from({ length: Math.max(last - first + 1, 0) }, (_, i) => map[first + i]);
  if (lines.length && lines.every((j, i) => j >= 0 && (i === 0 || j === lines[i - 1] + 1))) {
    return { start: lines[0] + 1, end: lines[lines.length - 1] + 1, lost: false };
  }
  const added = new Uint8Array(after.length).fill(1);
  for (const j of map) if (j >= 0) added[j] = 0;
  const above = before.slice(Math.max(0, first - CONTEXT), first);
  const below = before.slice(last + 1, last + 1 + CONTEXT);
  const neighbours = (start: number, length: number) =>
    above.filter((l, i) => after[start - 1 - above.length + i] === l).length +
    below.filter((l, i) => after[start - 1 + length + i] === l).length;
  const moved = (text: string[]) => {
    if (!text.length) return undefined;
    const scored = occurrences(after, text)
      .filter((start) => added.subarray(start - 1, start - 1 + text.length).every(Boolean))
      .map((start) => ({ start, score: neighbours(start, text.length) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = scored;
    if (!best || (next && (best.score < 2 || best.score === next.score))) return undefined;
    return { start: best.start, end: best.start + text.length - 1, lost: false };
  };
  const found = moved(before.slice(first, last + 1)) ?? (snippet ? moved(snippet) : undefined);
  if (found) return found;
  let prior = first - 1;
  while (prior >= 0 && map[prior] < 0) prior--;
  const start = Math.min(map[first] >= 0 ? map[first] : prior >= 0 ? map[prior] + 1 : 0, Math.max(after.length - 1, 0)) + 1;
  const end = last >= first && map[last] >= map[first] && map[first] >= 0 ? map[last] + 1 : start + span.end - span.start;
  return { start, end: Math.min(end, Math.max(after.length, 1)), lost: true };
}
