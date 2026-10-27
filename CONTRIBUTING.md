# Contributing to Prereview

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Building

You need Node.js 22 or later, git, and VS Code or Cursor.

```sh
npm install
npm run compile
```

Open the folder in VS Code and press <kbd>F5</kbd>. That starts an Extension Development Host with your build of Prereview. Run `npm run watch` to recompile on save, then reload the host window (**Developer: Reload Window**) to pick up the changes.

To install your build in your normal editor:

```sh
npm run package
code --install-extension prereview-0.1.0.vsix
```

## Testing

```sh
npm test
```

The unit tests use `node:test`. They cover git commands and their parsing, the review file format, the file tree, and `Review`, which runs against a small stand-in for the `vscode` module (`src/test/fakeVscode.ts`; import `./stubVscode` first in a test that needs it). Tests that need git create a throwaway repository in the temp folder.

`npm run test:integration` runs a few smoke tests inside a real VS Code, which it downloads into `.vscode-test/` the first time. On Linux without a display, run it under `xvfb-run -a`. CI runs it on Ubuntu.

## Layout

- `src/extension.ts`: activation, commands and the **Start Review** flow.
- `src/review.ts`: one review. It reads and writes the review file, asks git for the changed files, tracks viewed files and moves threads along with their code.
- `src/model.ts`: the review file format and the instructions for agents that are written into every review file.
- `src/git.ts`: git commands and the parsing of their output.
- `src/comments.ts`: the comment threads in diff editors, built on the VS Code Comments API.
- `src/overview.ts`, `media/overview.js`, `media/overview.css`: the overview webview. The extension posts a state object and the webview renders it.
- `src/reviewsView.ts`, `src/filesView.ts`, `src/fileTree.ts`: the **Reviews** and **Changed Files** views.

## Pull requests

- Keep a pull request to one change, and describe what it does and how you tested it.
- Match the style of the surrounding code.
- Add or update tests for behaviour you change, where it can be tested without VS Code.
- The overview follows the color theme: take every color from a `--vscode-*` variable, and check a light, a dark and a high contrast theme.
- If you change the review file format, update the agent instructions in `src/model.ts` and the README.

## Releasing

1. Set the new `version` in `package.json`, add a section to `CHANGELOG.md`, and merge that into `main`.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   The [Release workflow](.github/workflows/release.yml) runs the tests, packages the extension and drafts a GitHub release with the `.vsix`. It refuses to run when the tag doesn't match the version.
3. Open the drafted release on GitHub, edit the notes and publish it.
