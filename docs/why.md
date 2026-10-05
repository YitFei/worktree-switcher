# Why worktree-switcher exists

## The problem

Git worktrees let one repository have several working folders at once, each on its own branch.
With AI coding agents this became the normal way to work: tools like Orca create one worktree per
task, and each agent edits its own copy in parallel. You don't need to stash or switch branches
any more, and agents don't step on each other's files.

The code is isolated. **The running app is not.** Every worktree is a full copy of the same app,
so every worktree wants the same dev ports:

- The frontend dev server listens on, say, `5173`. Bookmarks, the browser's saved logins and
  cookies, and OAuth redirect URIs registered with an identity provider all point at
  `http://localhost:5173`.
- The frontend's dev proxy sends `/api` to the backend's fixed port, say `3000`.
- The backend's CORS settings and auth callbacks expect those same ports.

Only one process can listen on a port. So with five worktrees there is still exactly one
"the app", and in practice this goes wrong in several ways:

1. **Silent port drift.** Start a second Vite and it quietly moves to `5174`. That page then has
   the wrong origin: login redirects go back to `5173` (the *other* worktree), cookies don't
   match, and the API proxy may point at the other worktree's backend. You end up testing a mix of
   two branches without knowing it.
2. **Slow manual switching.** To look at another worktree you find the terminal, stop the
   servers, `cd`, and start them again: frontend and backend, every time. With .NET a cold start
   takes tens of seconds.
3. **"Which one am I looking at?"** Nothing on screen tells you which worktree the browser is
   showing right now.
4. **Agents fight over ports.** Agents start `npm run dev` or `dotnet run` on their own. One
   agent kills another agent's server to free a port, or starts a duplicate on a drifted port and
   then reports "it works" from the wrong copy.
5. **Leftovers.** Remove a worktree and its servers often keep running, holding the ports with
   code from a folder that no longer exists.

Neither git, nor Orca, nor any editor extension we found manages this on Windows. They all
leave ports to the repository.

## Why local development is tied to fixed ports

A real app rarely runs on its own. Local development usually wires the app into many other
services, and each of those connections names a fixed `localhost` address:

| service the app talks to | what is pinned to the port |
|---|---|
| Identity provider (Keycloak, Auth0, Entra ID, Google OAuth, …) | Registered redirect URIs and allowed origins (`http://localhost:5173/callback`). Many providers accept only exact, pre-registered URLs. |
| Your own backend APIs | The frontend's dev proxy (`/api → localhost:3000`), `.env` files (`VITE_API_URL`), CORS allow-lists |
| Other internal services / microservices | Service URLs in config: a gateway, a file service, a notification service calling back into the API |
| Webhooks and tunnels (Stripe CLI, ngrok, GitHub webhooks) | `stripe listen --forward-to localhost:3000/webhook`, a tunnel bound to one local port |
| Third-party sandboxes (payments, maps, mail) | Return URLs and allowed origins configured in their dashboards |
| Browser state | Cookies, localStorage and saved logins are scoped by origin, and a port is part of the origin |
| Shared infrastructure (database, Redis, message queue in Docker) | Shared by every worktree on purpose. Not part of the problem, and wts never touches it. |

Changing the port of one worktree means updating several of these, sometimes in an external
dashboard you may not even have access to. Multiply that by every worktree and every agent, and
"just use another port" stops being an answer. The practical rule is: **the outside world only
ever sees the fixed ports**. What can change is which worktree's code is behind them.

That one rule can be implemented in two ways, and wts supports both.

## What wts does

A small CLI that, for each repository, decides **which worktree owns the fixed ports**, plus:

- a floating button that always shows the answer and switches with one click;
- an MCP server and a hook, so agents use the same mechanism instead of starting their own servers;
- strict rules on what it may stop, so it never kills something it does not own.

## Design decisions

### Keep the fixed ports

The app's configuration (OAuth redirects, CORS, the dev proxy, bookmarks) assumes fixed ports.
Giving every worktree its own visible port or hostname (`feat-x.localhost`, `:5174`) means
changing that configuration for each worktree, and identity providers often need every redirect
URI registered in advance. So the browser always talks to the fixed ports; wts only decides who is
behind them.

### Two modes, because both habits are valid

Both modes keep every external integration on the fixed ports. They differ in *where the
worktree's servers run* and *what a switch costs*.

#### Run mode: one worktree owns the real ports

```
IdP redirect ─┐
webhooks     ─┼─▶ :5173 / :3000  ──▶  worktree B's servers   (A's were stopped)
browser      ─┘
```

`wts switch` stops the current owner's process trees and starts this worktree's servers, using
the commands in `wts.json`, directly on the fixed ports. Then it waits until every port listens.

- **Integrations.** Nothing changes. The servers really listen on the fixed ports, so redirects,
  webhooks, CORS and cookies behave exactly as when you run the app by hand.
- **The app.** No changes; the start command is the one you already use.
- **Cost of a switch.** A cold start of every service: seconds for Node/Vite, tens of seconds for
  a large .NET or Java backend.
- **Resources.** One set of servers, whatever the number of worktrees.
- **Hot reload.** Only for the worktree that runs.
- **Agents.** They must not start servers themselves. They call `wts_switch` / `wts_restart`, and
  the hook enforces this, because a second server would fight over the fixed port.
- **Best for:** heavy backends, machines with little memory, apps that restart on every change
  anyway (ASP.NET without hot reload), and teams that want zero setup.

#### Proxy mode: every worktree runs, wts forwards the real ports

```
IdP redirect ─┐                         ┌─▶ :5174 / :3001  worktree A (still running)
webhooks     ─┼─▶ :5173 / :3000 [wts] ──┼─▶ :5175 / :3002  worktree B  ◀── selected
browser      ─┘                         └─▶ :5176 / :3003  worktree C
```

Every worktree runs its own servers, started by you or an agent, on its own **assigned port**
from a range (`targets`). wts holds the fixed ports and forwards each TCP connection to the
selected worktree.

- **Integrations.** Still nothing changes, because the outside world only sees the fixed ports.
  The proxy works at TCP level, so the `Host` header, WebSockets (HMR, SignalR) and streaming pass
  through as they are.
- **The app.** Each service must accept a port other than the fixed one (`--port`, `PORT=`,
  `--urls`). Inside the app, keep pointing at the *fixed* ports (e.g. the dev proxy's
  `/api → localhost:3000`). The wts proxy forwards every fixed port to the same worktree, so the
  frontend and the backend always come from the same worktree.
- **Cost of a switch.** None: the selection changes, open connections are reset and the browser
  reconnects.
- **Resources.** One set of servers per worktree.
- **Hot reload.** In every worktree, all the time. This matches the habit of starting
  `npm run dev` once and leaving it open.
- **Agents.** Each agent starts its own server on its assigned port (`wts_port` tells it the port
  and the command) and can test its own worktree directly on that port. Agents don't disturb the
  fixed ports you are looking at.
- **Best for:** frontend-heavy work, fast hot-reload stacks, several agents that each need a
  running app, and comparing worktrees side by side quickly.

#### Side by side

| | run | proxy |
|---|---|---|
| External integrations (OAuth, webhooks, CORS, cookies) | work, on the real ports | work, through the forwarded ports |
| App changes needed | none | services must accept another port |
| Switch time | cold start of every service | instant |
| Memory / CPU | one server set | one server set per worktree |
| Hot reload | the running worktree | every worktree |
| Who starts servers | wts (from `cmd`) | you / your agents |
| Agents testing their own work | one at a time, through `wts_switch` | all at once, each on its assigned port |
| Risk of mixing frontend A with backend B | none (one worktree runs) | none (every fixed port follows the selection) |

**Choosing.** Start with run mode: it needs nothing but a `wts.json`. Move to proxy mode when
switches feel slow, or when several agents need running servers at the same time. The mode is set
per repository in `wts.json`, and different projects can use different modes under the same
`wts watch`.

Run mode is the default because it needs no changes to how the app starts.

### Manual by default, Auto as an option

Auto-switching to whatever worktree you select (in Orca) sounds ideal. But you often *look at*
one worktree's code while *testing* another, and an unexpected switch costs a restart in run mode.
So the default is Manual: switch from the button menu, the CLI, or an agent. Auto is one click
away. It waits until the selection has been stable for a few seconds (`--delay`), and it only
reacts when the selection *changes*, so a manual switch is never undone.

### Never kill what you can't prove you own

Ports are shared with everything else on the machine: Docker, another project, a database, a
server you started by hand. wts stops a process only if it can attribute it to a worktree of this
repository:

- wts started it. The process tree and its creation time are recorded, so a reused PID never
  matches.
- Its executable path, command line, or current directory is inside a worktree of the repo.

Anything else is reported by name ("port 5173 is held by `node.exe` pid 1234, not a worktree of
this repo") and left alone. The proxy follows the same rule. It never binds a port another program
serves; it waits until the port is free. It also holds both the IPv4 and the IPv6 address, because
on Windows another program could otherwise bind the same port on the other address and receive
some of the traffic.

### Agents use the tool, not the shell

Telling an agent "don't start dev servers" in a prompt is not reliable. wts gives agents:

- **MCP tools** (`wts_status`, `wts_switch`, `wts_restart`, `wts_logs`, `wts_port`, `wts_stop`,
  `wts_init`), plus server instructions that explain the rules for each mode;
- **a PreToolUse hook** that blocks `npm run dev`, `vite`, `dotnet run`/`watch` and the like in
  run-mode worktrees, and any `wts --force`. Blocking turns the rule into a hard stop with a clear
  message that points to `wts_switch`.

Locks (`wts lock`) are for people. An agent may never override one; it has to tell you.

### Windows first

The tools we found that solve the "one app, many worktrees" problem target Linux and macOS, and
say Windows process-tree management is unsupported. Our own use is Windows with .NET and Vite, so
wts starts there. It uses PowerShell for port and process queries, reads the process's current
directory from the PEB with a small compiled helper, uses `taskkill /T` for process trees, and
draws the floating button with WinForms. Porting to macOS and Linux means replacing
`src/platform/` (see [how-it-works.md](how-it-works.md)).

## Alternatives we looked at

| tool | approach | why not (for this use) |
|---|---|---|
| [pioootrek/worktree-switcher](https://github.com/pioootrek/worktree-switcher) | Fixed ports with one owner at a time; stops only the process trees it started; human locks, agent claims, dashboard, MCP | The same core idea, and the safety rule comes from it. But Linux first: Windows process-tree and service management are documented as unsupported. No editor or Orca focus following. |
| [portree](https://github.com/fairy-pitta/portree) | Hash-based port per branch plus a reverse proxy on `<branch>.localhost` | Every worktree gets a different origin, so OAuth redirects and CORS break. Windows support was experimental. |
| TreeHugger (VS Code) | A ▶ button per worktree runs the app in its own terminal; ports left to the repo | No port ownership; each repo must invent port offsets and `.env` files. |
| vscode-git-worktrees, git-worktree-switcher (fzf), … | Create, switch and delete worktrees | No dev-server handling. |
| Doing it by hand | Stop, `cd`, start | Slow, error-prone, and invisible to agents. |

How wts differs, in short:

- Windows and .NET are first-class.
- Two modes: one server set at a time, or all running behind a forwarder.
- A floating indicator, with optional Orca-follow.
- Agents are guided through MCP and blocked through a hook.
- No server process to install: state is plain JSON shared by the worktrees of a repo.

## Non-goals

- Creating or deleting worktrees (Orca, your editor, or `git worktree` already do that).
- Sharing databases, Docker containers or other infrastructure between worktrees; wts never
  touches them.
- Production or remote use. wts is a local development tool; its proxy only accepts connections
  from the same machine.
