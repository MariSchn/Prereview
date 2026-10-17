# Prereview

A VS Code extension for reviewing agent-written changes locally, like a GitHub pull request, without opening a PR or cluttering the history.

## Install

```sh
npm install
npm run package
code --install-extension prereview-0.1.0.vsix
```

To develop, open this folder in VS Code and press F5.

## Use

1. Open **Prereview** in the activity bar and click **Start Review**. Pick a base branch, then what to compare it with:
   - **Working tree**: the current branch plus uncommitted changes.
   - **Another branch**: if it is checked out in a worktree (an agent's, for example), Prereview reviews that worktree, uncommitted changes included. Otherwise it shows the branch's commits.

   When the reviewed code is a working tree, you can edit it right in the diff.
2. The **overview** works like GitHub's Conversation tab: the agent's title and description, every thread grouped into *Awaiting you*, *Awaiting agent* and *Resolved*, and a box for general comments.
3. **Changed Files** shows the changes as a tree with +/− counts. Click a file for its diff, or use **Open All Changes** to see every diff in one view. Tick files as **viewed** as you go. If the agent changes a viewed file, it gets unticked and **Open Changes Since Viewed** shows only what changed.
4. Hover the line numbers and click **+** to comment (drag to select a range). You can also comment on a whole file, on removed lines in the old version, or on the change as a whole from the overview. Edit or delete your comments, and resolve threads once they are addressed.
5. Click **Copy Review Path** and send the path to your agent, like a PR link. The file tells the agent how to reply. The badge on the Prereview icon counts threads awaiting you, and a notification appears once the agent has answered every open thread.
6. **Finish Review** deletes the review when you are done.

## Review file

Reviews are stored in `.prereview/<base>...<target>.json` at the repository root. The folder ignores itself, so nothing gets committed.

```json
{
  "agentInstructions": "...",
  "title": "Make average() safe for empty input",
  "description": "Guards `average()` against empty arrays.",
  "base": "main",
  "target": "agent",
  "threads": [
    {
      "id": "3f2a9c1b",
      "file": "src/app.ts",
      "startLine": 12,
      "endLine": 14,
      "snippet": "let sum = 0;\n...",
      "resolved": false,
      "comments": [
        { "author": "reviewer", "body": "Rename `sum`.", "createdAt": "2026-10-17T10:00:00.000Z" },
        { "author": "agent", "body": "Renamed to `total`." }
      ]
    },
    { "id": "8c01d2e4", "file": "src/util.ts", "resolved": false, "comments": [...] },
    { "id": "51b7a0f9", "file": "src/app.ts", "side": "base", "startLine": 7, "endLine": 7, "snippet": "...", "resolved": false, "comments": [...] },
    { "id": "e93c4b10", "resolved": false, "comments": [...] }
  ]
}
```

`target` is `null` for working tree reviews. A thread without lines is about the whole file, a thread without `file` is a general comment, and `"side": "base"` puts it on the old version of the file. Agents fill in `title` and `description`, reply to threads, and can open threads of their own. Threads follow their code when lines move. If the commented code itself changes, the thread is marked **Outdated**.

## Tests

`npm test` compiles and runs the unit tests.
