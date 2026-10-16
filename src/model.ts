export interface Comment {
  author: string;
  body: string;
  createdAt?: string;
}

export interface Thread {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  resolved: boolean;
  comments: Comment[];
}

export interface ReviewData {
  base: string;
  target: string | null;
  threads: Thread[];
}

export const AGENT_INSTRUCTIONS =
  'This file is a local code review left with Prereview, like the comments on a GitHub pull request. ' +
  '`base` is the branch the changes are compared against; `target` is the branch under review, or null if the review covers the uncommitted working tree. ' +
  'Each entry in `threads` is a review comment on `file` (relative to the repository root), lines `startLine` to `endLine` (1-based) of the reviewed version; `snippet` is the code it was left on. ' +
  'For every thread with `resolved: false`, address the feedback in the code (or decide not to), then append a reply to its `comments` array: ' +
  '{"author": "agent", "body": "<what you changed, or why not>"}. If something is unclear, ask in a reply instead. ' +
  'Do not resolve threads, add threads, or edit or delete existing comments; the reviewer does that. Skip resolved threads. ' +
  'If `target` is a branch, commit your fixes to that branch so they show up in the review. ' +
  'Keep this file valid JSON; the reviewer\'s editor picks up changes automatically.';

export function reviewFileName(base: string, target: string | null): string {
  const slug = (s: string) => s.replace(/[^\w.-]+/g, '-');
  return `${slug(base)}...${slug(target ?? 'worktree')}.json`;
}

export function parseReview(text: string): ReviewData {
  const raw = JSON.parse(text);
  if (typeof raw?.base !== 'string') throw new Error('missing "base"');
  const threads: Thread[] = [];
  for (const t of Array.isArray(raw.threads) ? raw.threads : []) {
    if (typeof t?.id !== 'string' || typeof t.file !== 'string' || !Number.isInteger(t.startLine)) continue;
    const comments: Comment[] = (Array.isArray(t.comments) ? t.comments : [])
      .filter((c: any) => typeof c?.body === 'string')
      .map((c: any) => ({ author: typeof c.author === 'string' ? c.author : 'agent', body: c.body, createdAt: c.createdAt }));
    threads.push({
      id: t.id,
      file: t.file,
      startLine: t.startLine,
      endLine: Number.isInteger(t.endLine) ? t.endLine : t.startLine,
      snippet: typeof t.snippet === 'string' ? t.snippet : '',
      resolved: t.resolved === true,
      comments,
    });
  }
  return { base: raw.base, target: typeof raw.target === 'string' ? raw.target : null, threads };
}

export function serializeReview(data: ReviewData): string {
  return JSON.stringify({ agentInstructions: AGENT_INSTRUCTIONS, ...data }, null, 2) + '\n';
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
