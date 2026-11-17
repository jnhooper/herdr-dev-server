# Dev server

A side panel for your local dev servers (Rails, Storybook, ...), with at most one of each running. You can run one in the worktree you're looking at, restart it, stop it, or open it. Its log shows right below.

![Dev server](preview.png)

## What you see

A column in the side panel, top to bottom:

- **Head** (78 px, role `head`):
  - a row of 26 px server pills, one per server in `servers.json`; the selected one is highlighted
  - 24 px buttons:
    - `Run here` (or `Running here`)
    - `Restart`
    - `Stop` (danger)
    - `Open`, only while the server is running, with the URL as tooltip
  - a status line (11.5 px, `dim`):
    - `Starting…` or `Stopping…`
    - `Running · <worktree>`
    - `Not listening yet · <worktree>`
    - `Running outside Herdr · <folder>`
    - `Stopped`
    - an error from `servers.json`
- **Body** (the rest): the server's live terminal. When the server has no terminal here (stopped, or running outside Herdr), it is a copy of this mod with role `body`, showing the same actions.
- **Ask** (role `ask`): a dialog asking whether to migrate the shared database.

When herdr-critters is installed, it draws in the critters look (`critters-look.js`). Otherwise it uses Herdr's theme.

## How it behaves

- A poll every 2.5 s works out the state of each server and keeps it as shared `devserver.state`:
  - its herdr-core terminal (label `herdr.server=<id>`)
  - that terminal's cwd
  - whether anything listens on its port (`lsof`)
  - for a process outside Herdr: its pid, process group and cwd
- Each `hc` call has an 8 s timeout. A poll stuck for over 30 s is replaced.
- The poll also sets shared `devserver.dot`, for a tab bar's button dot: `done` when a server runs here, `working` when one runs only outside Herdr, null when nothing runs.
- **Run here**:
  1. Takes the shown worktree's root. It must contain the server's `requires` file.
  2. Stops a copy running elsewhere.
  3. Starts a background terminal through the login shell (`hc run --bg`). In it, the server's `prepare` steps run first: each only when its `when` files changed since it last succeeded in that worktree (recorded in the worktree's git dir).
  4. Then pending migrations, with `migrate`:
     - `own-db` (the default): migrates by itself only when the worktree has its own database, that is when `database.var` in `database.env` isn't `database.shared`. On the shared database it asks first.
     - `always`
     - `never`
  5. Then `command`.
- **Stop**:
  1. Sends `ctrl+c` to every live terminal with the server's label.
  2. Waits for the port to free.
  3. Sends `-INT` and then `-TERM` to the process group of whatever still listens on the port.
  4. Ends the terminals.
- **Open**: `open <url>`.
- The head points the body block at the selected server's terminal (`layout.set`), or back at the role `body` copy.

## Built from

- **Layout**: a column in the side panel's stack with id `server`. Its children are `server-head` (`{ "mod": "dev-server", "props": { "role": "head" } }`, 78 px) and `server-term` (`{ "mod": "dev-server", "props": { "role": "body" } }`).
- **Mod** `mods/dev-server/`:
  - `main.js`
  - `critters-look.js` (a copy)
  - icons: `server.svg`, `refresh.svg`, `external.svg`
  - `servers.example.json`
  - `mod.json`: `place: none`, and `"panel": { "label": "Server", "icon": "server.svg", "dot": "devserver.dot" }`
- **Your config** `mods/dev-server/servers.json`: never in the repo. The install script writes it once from the example.
- **herdr functions**: `spaces`, `panes`, `focused`, `exec`, `hc`, `run`, `layout`, `theme`, `shared`, `setShared`, `props`, `readTextFile`, `appHome`, `notify`, `openOverlay`, `closeOverlay`.
- **Programs**: `hc` (`ls`, `run --bg`, `keys`, `kill`), `lsof`, `ps`, `kill`, `open`, your login shell, `git`.

## Watch out

- `hc()` has no timeout of its own, and one stuck call used to freeze the panel's state. Every call is wrapped with a timeout.
- Stopping by terminal alone misses servers whose terminal moved or was lost. Stop also goes by the port.
- `servers.json` is personal (commands, database names): keep it out of the repo.
