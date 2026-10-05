# Contributing to worktree-switcher

Thanks for helping. This page covers everything needed to work on wts: setup, layout, testing
without breaking your own dev environment, and releasing.

Read [docs/why.md](docs/why.md) first, then [docs/how-it-works.md](docs/how-it-works.md). The
design rules there, especially *never kill a process you cannot attribute*, are not negotiable
in a pull request.

## Setup

You need Windows 10/11, Node.js 22+, git, and Windows PowerShell 5.1 (built in).

```sh
git clone https://github.com/YitFei/worktree-switcher.git
cd worktree-switcher
npm install
npm run build        # tsc: src/ → dist/src, test/ → dist/test
npm test             # build + node --test
npm link             # puts your build on PATH as `wts`
```

After `npm link`, `wts` runs your local `dist/`. Rebuild after every change (`npm run build`),
and restart any running `wts watch` and agent sessions. They load the code once, at start.
`wts setup` points Claude Code at this checkout's `dist/src/cli.js`.

## Project layout

The full module map is in [docs/how-it-works.md](docs/how-it-works.md#map-of-the-source). Short
version:

- `src/cli.ts`: commands; `src/commands/*`: one file per command.
- `src/owner.ts`, `src/discover.ts`, `src/ports.ts`, `src/proxy.ts`: the logic. Mostly pure and
  unit-tested.
- `src/platform/*`: Windows-only code (PowerShell queries, the WinForms widget).
- `src/mcp.ts`, `src/hook.ts`, `src/commands/setup.ts`: the agent integration.
- `examples/demo`: the demo servers, also used by the root `wts.json`.

## Conventions

- TypeScript strict mode, ESM, Node built-ins only. The only runtime dependencies are the MCP SDK
  and zod; think twice before adding one.
- Keep logic pure where possible (`assignPorts`, `attributeListeners`, `checkCommand`,
  `withHook`, `alignRoutes` …) and test it in `test/*.test.ts`. Keep the side effects in
  `platform/` and `commands/`.
- User-facing messages say what happened and what to do next ("port 5173 is held by node.exe
  pid 1234, not a worktree of this repo; stop it yourself"). Exit codes: 1 = failure, 2 = refused.
- Comments explain *why* (especially Windows quirks), not what.
- Test fixtures use generic names (`C:\dev\MyApp`, user `dev`), never real users or companies.

## Testing safely

wts stops processes and binds ports. Tested carelessly, it can break your own running dev
environment, or the repo of a `wts watch` you are using right now.

1. **Unit tests first.** `npm test`. Most logic can be tested without processes or ports.
2. **Use an isolated clone for end-to-end tests**, never the repo a live `wts watch` serves:
   ```sh
   git clone . %TEMP%\wts-e2e && cd %TEMP%\wts-e2e
   git worktree add ..\wts-e2e-a && git worktree add ..\wts-e2e-b
   ```
   Change the ports in that clone's `wts.json` (e.g. 4873 / 4941) so nothing collides with
   anything else you run. A running `wts watch` remembers every configured repo it has seen, so a
   test repo on the same ports would compete with it.
3. **Run watch without UI and without Orca:** `wts watch --ui none --no-orca`. To test Auto mode,
   use `wts focus <path>`, or pass `--orca-db <copy of a profile-state.db>` to test the Orca reader
   on a copy.
4. **Clean up:** `wts stop` in the clone, `git worktree remove`, delete the clone. Check that
   nothing is left listening (`wts status`, or `Get-NetTCPConnection -State Listen -LocalPort 4873`).

### Checking the floating button

The widget is PowerShell + C#, built as strings in `src/platform/widget.ts`, so the TypeScript
compiler does not check it. After changing it:

- **Parse check.** Have `wts watch` write the script (it lands in `~/.wts/widget-<pid>.ps1`), then:
  ```powershell
  $errs = $null
  [System.Management.Automation.Language.Parser]::ParseFile("$HOME\.wts\widget-<pid>.ps1", [ref]$null, [ref]$errs)
  $errs
  ```
- **Visual check.** Run `wts watch` against the isolated clone and look at it, including the menu,
  at 100% and at 150% display scaling. For layout work (column alignment), render the menu
  offscreen: build the `ContextMenuStrip`, call `DrawToBitmap`, and save a PNG, so you can compare
  before and after.
- The button must never take focus. Click it while typing in an editor; the editor must keep
  the caret.

### Checking the agent integration

- Hook: `echo '{"tool_name":"Bash","cwd":"<run-mode worktree>","tool_input":{"command":"npm run dev"}}' | wts hook`
  must exit 2. The same input with `git commit -m "npm run dev"` must exit 0.
- MCP: after `npm run build`, reconnect the server (`/mcp` in Claude Code) and ask the agent to
  call `wts_status`. Or run a one-off: `claude -p "use wts_status and tell me who serves the ports"`.

## Pull requests

- One topic per PR. Describe the problem, the change, and how you tested it (unit and/or e2e).
- `npm test` must pass. CI runs it on `windows-latest` with Node 22.
- Update `README.md` / `docs/` when behaviour or commands change, and add a line under
  `## [Unreleased]` in `CHANGELOG.md`.

## Releasing (maintainers)

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading with the date.
2. `npm version <patch|minor|major>`. This updates package.json and creates the commit and the `vX.Y.Z` tag.
3. `npm pack --dry-run` and check the file list: only `dist/src`, `docs`, `examples`, README,
   CHANGELOG, LICENSE, package.json.
4. `npm publish` (runs `npm test` first via `prepublishOnly`). You need `npm login` once.
5. `git push --follow-tags`, then create a GitHub release from the tag with the CHANGELOG section.
