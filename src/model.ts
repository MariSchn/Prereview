import { createHash } from 'crypto';
import * as path from 'path';

export const REVIEWER = 'reviewer';

export function authorName(author: string): string {
  if (author === REVIEWER) return 'You';
  const name = author || 'agent';
  return name[0].toUpperCase() + name.slice(1);
}

export interface Comment {
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
}

export interface ReviewData {
  title: string;
  description: string;
  base: string;
  target: string | null;
  threads: Thread[];
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
  'For every thread with `resolved: false` whose last comment is the reviewer\'s, address the feedback in the code (or decide not to), then append a reply to its `comments`: ' +
  '{"author": "agent", "body": "<what you changed, or why not>"}. If something is unclear, ask in a reply instead. ' +
  'You may also open a thread to point the reviewer to something or ask a question by appending ' +
  '{"id": "<unique id>", "file": "<path>", "startLine": <n>, "endLine": <n>, "resolved": false, "comments": [{"author": "agent", "body": "..."}]} to `threads` ' +
  '(leave out the lines for a whole-file comment, or `file` for a general one). ' +
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

export function reviewFileName(base: string, target: string | null): string {
  const slug = (s: string) => s.replace(/[^\w.-]+/g, '-');
  return `${slug(base)}...${slug(target ?? 'worktree')}.json`;
}

export function parseReview(text: string): ReviewData {
  const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (typeof raw?.base !== 'string') throw new Error('missing "base"');
  const threads: Thread[] = [];
  const ids = new Set<string>();
  for (const t of Array.isArray(raw.threads) ? raw.threads : []) {
    const comments: Comment[] = (Array.isArray(t?.comments) ? t.comments : [])
      .filter((c: any) => typeof c?.body === 'string')
      .map((c: any) => ({
        author: typeof c.author === 'string' ? c.author : 'agent',
        body: c.body,
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : undefined,
      }));
    if (!comments.length) continue;
    const file = typeof t.file === 'string' && t.file ? repoPath(t.file) : undefined;
    const startLine = file ? lineNumber(t.startLine) : undefined;
    let id = typeof t.id === 'string' && t.id ? t.id : hashId(`${file}:${startLine}:${comments[0].body}`);
    if (ids.has(id)) id = `${id}-${threads.length}`;
    ids.add(id);
    threads.push({
      id,
      file,
      side: file && t.side === 'base' ? 'base' : undefined,
      startLine,
      endLine: startLine === undefined ? undefined : Math.max(lineNumber(t.endLine) ?? startLine, startLine),
      snippet: startLine !== undefined && typeof t.snippet === 'string' ? t.snippet : undefined,
      resolved: t.resolved === true,
      comments,
    });
  }
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    base: raw.base,
    target: typeof raw.target === 'string' ? raw.target : null,
    threads,
  };
}

function lineNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function repoPath(file: string): string | undefined {
  const normal = path.posix.normalize(file.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(normal) || path.win32.isAbsolute(normal) || /^\.\.?(\/|$)/.test(normal)) return undefined;
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
    comments,
  }));
  return JSON.stringify({ agentInstructions: AGENT_INSTRUCTIONS, title, description, base, target, threads }, null, 2) + '\n';
}

export function newId(): string {
  return hashId(`${Date.now()}:${Math.random()}`);
}

function hashId(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

export function locate(lines: string[], snippet: string, startLine: number): { start: number; end: number } | undefined {
  const want = snippet.split('\n').map((l) => l.trimEnd());
  const matchesAt = (s: number) => want.every((l, k) => lines[s - 1 + k]?.trimEnd() === l);
  const span = (s: number) => ({ start: s, end: s + want.length - 1 });
  if (matchesAt(startLine)) return span(startLine);
  let best: number | undefined;
  for (let s = 1; s + want.length - 1 <= lines.length; s++) {
    if (matchesAt(s) && (best === undefined || Math.abs(s - startLine) < Math.abs(best - startLine))) best = s;
  }
  return best === undefined ? undefined : span(best);
}
