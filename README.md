# Prereview

A VS Code extension for reviewing agent-written changes locally, like a GitHub pull request, without opening a PR or cluttering the history.

## Install

```sh
npm install
npm run package
code --install-extension prereview-0.0.1.vsix
```

To develop, open this folder in VS Code and press F5.

## Use

1. Open **Prereview** in the activity bar and click **Start Review**.
2. Pick a base branch, then what to compare it with:
   - **Working tree**: the current branch plus uncommitted changes. Edits you make in the diff go straight to your files.
   - **Another branch**: committed changes on that branch (read-only).
3. Click a file to open its diff, or **Open All Changes** to see every diff in one view. Hover the line numbers and click **+** to comment (drag to select a range).
4. Click **Copy Review Path** and send the path to your agent, e.g. "Address the review in `<path>`". The file tells the agent how to reply.
5. Agent replies show up in the threads as soon as the file changes. Reply, or resolve threads once they are addressed.

## Review file

Comments are stored in `.prereview/<base>...<target>.json` at the repository root. The folder ignores itself, so nothing gets committed.

```json
{
  "agentInstructions": "...",
  "base": "main",
  "target": null,
  "threads": [
    {
      "id": "3f2a9c1b",
      "file": "src/app.ts",
      "startLine": 12,
      "endLine": 14,
      "snippet": "const x = compute(a, b);\n...",
      "resolved": false,
      "comments": [
        { "author": "reviewer", "body": "Rename `x`.", "createdAt": "2026-10-17T10:00:00.000Z" },
        { "author": "agent", "body": "Renamed to `total`." }
      ]
    }
  ]
}
```

`target` is `null` for working tree reviews. Threads follow their code when lines move. If the commented code itself changes, the thread is marked **Outdated**.

## Tests

`npm test` compiles and runs the unit tests.
