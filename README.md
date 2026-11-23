# herdr-dev-server

A [Herdr](https://herdr.dev) side-panel mod for your local dev servers (Rails, Storybook, ...), with at most one of each running. Pick a server, then use Run here (in the shown worktree), Restart, Stop or Open. Servers run as background herdr-core terminals through your login shell, so they don't take a tab. A server already listening on its port outside Herdr is found by port, and Stop can stop it too.

Before a server starts, each `prepare` step runs in its terminal, so you can watch it. A step runs only when its `when` files changed since it last succeeded in that worktree (for example `bundle install` when `Gemfile.lock` changed). Pending migrations run next. On a database shared between worktrees, it asks before migrating.

## Install

```sh
./install.sh
```

The first install writes `mods/dev-server/servers.json` from `servers.example.json`. Edit it for your apps. Later installs keep your copy.

Add it to your layout's side-panel stack, with its header over the server's terminal:

```json
{ "id": "server", "type": "column", "children": [
  { "id": "server-head", "type": "block", "content": { "mod": "dev-server", "props": { "role": "head" } }, "size": { "px": 78 } },
  { "id": "server-term", "type": "block", "content": { "mod": "dev-server", "props": { "role": "body" } } }
] }
```

## servers.json

| Key | Meaning |
|---|---|
| `id`, `label` | name and what the switch shows |
| `port`, `url` | where it listens, and what Open opens |
| `command` | how to start it, run at the worktree root |
| `requires` | a file that must exist at the root for Run here to be offered |
| `prepare` | steps: `{ name, when: [files], run }` |
| `migrate` | `"own-db"` (default), `"always"` or `"never"` |
| `database` | `{ env, var, shared, makeOwn }`: the env file and variable that name the database, the shared one, and a command that makes the worktree its own |

`migrate`, `migrateCommand` and `database` are optional. Leave them out for anything without Rails-style migrations.

One `servers.json` serves every project. Every server shows in every space, but Run here is offered only in worktrees that have its `requires` file. Put a Rails app and a Node app in the same file and each one runs only in its own repo.

The panel knows a server is running only by its port being listened on:

- Every entry needs a `port`. The ports are checked together, so an entry without one breaks the status of all of them.
- Give each entry its own port. Two entries on the same port both show as running when either one is.
- A command that listens on no local port never shows as running. Pair it with something that does, as in the Convex example below.

### Example: a Convex app

`npx convex dev` syncs your functions to Convex's cloud and listens on no local port. Run it together with the frontend as one server, and give the frontend's port:

```json
{
  "id": "convex",
  "label": "Convex",
  "port": 5173,
  "url": "http://localhost:5173",
  "command": "npm run dev",
  "requires": "convex",
  "prepare": [
    { "name": "npm", "when": ["package-lock.json"], "run": "npm install" }
  ]
}
```

- `npm run dev` in Convex's templates runs the frontend and `convex dev` together. Without such a script, use `"npx convex dev & npm run dev:frontend; wait"`. Stop ends both, since they share one terminal.
- 5173 is Vite's port. For Next.js, pick a port no other entry uses: `next dev -p 3001` and `"port": 3001`.
- `requires: "convex"` is the `convex/` folder at the repo root.
- No migration keys: Convex pushes its schema itself.
- With the local backend (`npx convex dev --local`), Convex listens on 3210, so it can also be its own entry on that port.

`servers.json` is read when the panel starts. After editing, restart Herdr or touch `mods/dev-server/main.js`.

With [herdr-critters](https://github.com/jnhooper/herdr-critters), the tab bar's Server button and its running dot come from `mod.json` `panel` (shared `devserver.dot`).
