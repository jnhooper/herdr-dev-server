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

With [herdr-critters](https://github.com/jnhooper/herdr-critters), the tab bar's Server button and its running dot come from `mod.json` `panel` (shared `devserver.dot`).
