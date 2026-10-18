# Security

Report a vulnerability through [GitHub security advisories](https://github.com/MariSchn/Prereview/security/advisories/new). Please don't open a public issue for it.

## What Prereview does on your machine

Prereview runs only in a workspace you have trusted, and it has no network of its own.

- It runs git in the repository you have open: diffs, `rev-parse`, `merge-base`, `show`, `ls-files`, `worktree list`, and `hash-object`. It does not fetch, push, or talk to a remote.
- It writes review files under `.prereview/` and, when you mark a file as viewed, stores a snapshot of that file as a git object so it can later show what changed.
- Comments and agent replies are markdown. The overview page blocks scripts and images loaded from the network. A review file is data the agent can edit, so treat a review from an untrusted source the way you would treat untrusted code.
