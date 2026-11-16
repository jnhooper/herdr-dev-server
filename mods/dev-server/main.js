// The local dev servers (Rails, Storybook, ...) in the right panel: one of each at most.
//
// Two copies of this mod make the panel (layout stack child `server`):
//   role "head": the server switch, where it runs, Run here / Restart / Stop / Open.
//                It also keeps the state (shared "devserver.state") and points the block
//                below at the shown server's terminal.
//   role "body": what shows below when that server has no terminal here (stopped, or
//                running outside Herdr), with the same actions.
//
// Servers are background herdr-core terminals (label herdr.server=<id>), started in the
// worktree's root through your login shell, so they don't show as tab panes. A server
// already listening on its port outside Herdr (another terminal app) is found by port.
// The commands are in servers.json; `requires` is a file that must exist at the root of a
// worktree for Run here to offer it (Procfile.dev: a checkout of the Rails app).
//
// Before the server starts, in its own terminal (so you see it): each `prepare` step runs
// only when its `when` files changed since it last succeeded in that worktree (recorded in
// the worktree's git dir), then pending migrations. `migrate`: "own-db" (default) migrates
// by itself only when the worktree has its own database (`database.var` in `database.env`
// isn't `database.shared`) and asks first on the shared one; "always"; "never".
// A third copy, role "ask", is that question as a dialog.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, hc, run, layout, theme, shared, setShared, props, readTextFile, appHome, notify, openOverlay, closeOverlay } from "herdr";
import { critters, pixel } from "./critters-look.js";

const STATE_KEY = "devserver.state";
const DOT_KEY = "devserver.dot";
const SELECTED_KEY = "devserver.selected";
const ANSWER_KEY = "devserver.answer"; // the ask dialog's choice, picked up by the head
const LABEL = "herdr.server";
const TERM_BLOCK = "server-term";
const BODY = { mod: "dev-server", props: { role: "body" } };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// hc with a time limit. A call that never came back once froze the poll, so the panel
// kept showing a server that had moved, and Stop went to a terminal that was gone.
function hcT(args, ms = 8000) {
  const late = exec("sleep", [String(ms / 1000)]).then(() => ({ code: 124, stdout: "", stderr: `hc ${args[0]} timed out` }));
  return Promise.race([hc(args), late]);
}

const base = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The shown space's folder (its focused pane's, as Changes reads it).
function here() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { space, cwd: pane?.cwd || space?.folder };
}

export default class DevServer extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "head";
    this.servers = [];
    this.busy = {}; // id -> "starting" | "stopping"
    cx.spawn(async (cx) => {
      try { this.servers = JSON.parse(await readTextFile(`${appHome()}/mods/dev-server/servers.json`)).servers ?? []; }
      catch (e) { this.error = `servers.json: ${e.message ?? e}`; }
      if (this.role === "head") await this.poll(cx);
      cx.notify();
    });
    if (this.role === "head") {
      cx.timer.every(2500, (cx) => this.poll(cx));
      cx.timer.every(500, (cx) => this.checkFit(cx));
      // The "ask" dialog ends (and its tasks with it) the moment it closes, so its answer
      // comes here through shared state and the head, which stays open, does the work.
      cx.timer.every(300, (cx) => {
        const a = shared(ANSWER_KEY);
        if (!a || !this.servers.length) return;
        setShared(ANSWER_KEY, null);
        const srv = this.servers.find((x) => x.id === a.server);
        if (srv) this.act(srv, a.what, cx, { decision: a.decision, root: a.root });
      });
    }
  }

  selected() {
    const id = shared(SELECTED_KEY);
    return this.servers.find((s) => s.id === id) ?? this.servers[0];
  }

  // Whether the shown space's worktree can run each server (its `requires` file is at the
  // worktree's root). Looked up again only when the folder changes.
  checkFit(cx) {
    const { cwd } = here();
    if (!cwd || !this.servers.length || this.fitFor === cwd) return;
    this.fitFor = cwd;
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => ({ code: 1 }));
      const root = top.code === 0 ? top.stdout.trim() : null;
      const ok = {};
      for (const s of this.servers) {
        if (!s.requires) { ok[s.id] = true; continue; }
        ok[s.id] = root ? (await exec("test", ["-e", `${root}/${s.requires}`])).code === 0 : false;
      }
      if (this.fitFor === cwd) { this.fit = { cwd, root, ok }; cx.notify(); }
    });
  }

  // Who runs each server now: our terminal for it, and whatever listens on its port.
  async poll(cx) {
    if (!this.servers.length) return;
    if (this.polling && Date.now() - this.polling < 30000) return; // a poll stuck past 30s is given up on
    this.polling = Date.now();
    try {
      const state = {};
      const ports = this.servers.map((s) => `-iTCP:${s.port}`);
      const ls = await exec("lsof", ["-nP", ...ports, "-sTCP:LISTEN", "-Fpn"], { timeout: 5000 });
      // lsof -F: p<pid> then n<addr:port> lines.
      const listeners = {};
      let pid = null;
      for (const line of ls.stdout.split("\n")) {
        if (line.startsWith("p")) pid = +line.slice(1);
        else if (line.startsWith("n")) { const port = +line.split(":").pop(); listeners[port] ??= pid; }
      }
      for (const s of this.servers) {
        const r = await hcT(["ls", "--json", "--label", `${LABEL}=${s.id}`]);
        const term = r.code === 0 ? (JSON.parse(r.stdout).terminals ?? []).find((t) => t.state === "live") : null;
        const listener = listeners[s.port] ?? null;
        let external = null;
        if (listener) {
          // Is the listener ours (under our terminal's process)? Else note where it runs.
          const ours = term ? await this.under(listener, term.address) : false;
          if (!ours) {
            const cwd = await exec("lsof", ["-a", "-p", String(listener), "-d", "cwd", "-Fn"], { timeout: 5000 });
            const pg = await exec("ps", ["-o", "pgid=", "-p", String(listener)], { timeout: 5000 });
            external = { pid: listener, pgid: +pg.stdout.trim() || null, cwd: cwd.stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null };
          }
        }
        state[s.id] = {
          address: term?.address ?? null,
          cwd: term?.cwd ?? null,
          running: Boolean(listener),
          external,
          busy: this.busy[s.id] ?? null,
        };
      }
      if (JSON.stringify(shared(STATE_KEY)) !== JSON.stringify(state)) setShared(STATE_KEY, state);
      // The panel button's dot (mod.json "panel".dot): green when one runs here, amber when
      // one runs only outside Herdr, none when nothing runs.
      const all = Object.values(state);
      const dot = all.some((st) => st.running && !st.external) ? "done" : all.some((st) => st.running) ? "working" : null;
      if (shared(DOT_KEY) !== dot) setShared(DOT_KEY, dot);
      this.pointBlock(state);
    } catch (e) {
      this.error = String(e.message ?? e);
    }
    this.polling = false;
    cx.notify();
  }

  // Whether `pid` runs under the terminal `address` (its process or a descendant).
  async under(pid, address) {
    const g = await hcT(["get", address]);
    const root = g.code === 0 ? JSON.parse(g.stdout).pid : null;
    if (!root) return false;
    const ps = await exec("ps", ["-axo", "pid=,ppid="], { timeout: 5000 });
    const parent = {};
    for (const line of ps.stdout.trim().split("\n")) { const [p, pp] = line.trim().split(/\s+/).map(Number); parent[p] = pp; }
    for (let p = pid, n = 0; p > 1 && n < 50; p = parent[p], n++) if (p === root) return true;
    return false;
  }

  // The block under the head shows the selected server's terminal, else the body copy.
  // Herdr drops a layout block whose terminal ends, so a missing block is put back.
  pointBlock(state, force) {
    const tree = layout();
    const column = find(tree, "server");
    if (!column) return;
    const node = find(tree, TERM_BLOCK);
    const s = this.selected();
    const address = s && state[s.id]?.address;
    const want = force ?? (address ? { terminal: address } : BODY);
    if (node && JSON.stringify(node.content) === JSON.stringify(want)) return;
    const copy = JSON.parse(JSON.stringify(tree));
    const target = find(copy, TERM_BLOCK);
    if (target) target.content = want;
    else find(copy, "server").children.push({ id: TERM_BLOCK, type: "block", content: want });
    run("layout.set", { layout: copy });
  }

  // End a server terminal; the block stops showing it first, so Herdr doesn't drop it.
  async endTerminal(address) {
    if (find(layout(), TERM_BLOCK)?.content?.terminal === address) {
      this.pointBlock({}, BODY);
      await exec("sleep", ["0.3"]);
    }
    await hcT(["kill", address]);
  }

  async waitFree(port, ms = 20000) {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const r = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5000 });
      if (!r.stdout.trim()) return true;
      await exec("sleep", ["0.5"]);
    }
    return false;
  }

  // Stop it wherever it runs: our terminal gets Ctrl-C (foreman stops its children), an
  // outside one gets SIGINT to its process group, as Ctrl-C in its own terminal would.
  // It looks again rather than trusting the last poll: every live terminal of this server
  // gets Ctrl-C, then whatever still listens on the port gets SIGINT, then SIGTERM.
  async stopServer(s) {
    const r = await hcT(["ls", "--json", "--label", `${LABEL}=${s.id}`]);
    let terms = [];
    try { terms = r.code === 0 ? (JSON.parse(r.stdout).terminals ?? []).filter((t) => t.state === "live") : []; } catch {}
    for (const t of terms) await hcT(["keys", t.address, "ctrl+c"]);
    let free = terms.length ? await this.waitFree(s.port, 15000) : await this.waitFree(s.port, 500);
    for (const sig of ["-INT", "-TERM"]) {
      if (free) break;
      const ls = await exec("lsof", ["-nP", `-iTCP:${s.port}`, "-sTCP:LISTEN", "-t"], { timeout: 5000 });
      for (const pid of new Set(ls.stdout.split("\n").map((x) => x.trim()).filter(Boolean))) {
        const pg = +(await exec("ps", ["-o", "pgid=", "-p", pid], { timeout: 5000 })).stdout.trim();
        await exec("kill", [sig, pg > 1 ? `-${pg}` : pid]).catch(() => {});
      }
      free = await this.waitFree(s.port, 10000);
    }
    for (const t of terms) await this.endTerminal(t.address);
    return free;
  }

  // Which database the worktree at `root` uses, and which of its migrations it hasn't run.
  // pending: null when it couldn't be asked (no database yet, psql missing).
  async migrations(s, root) {
    const db = s.database;
    if (!db) return null;
    const env = await exec("sh", ["-c", `grep -E '^${db.var}=' ${shq(db.env)} | tail -1 | cut -d= -f2-`], { cwd: root });
    const name = env.stdout.trim().replace(/^["']|["']$/g, "") || db.shared;
    const files = await exec("ls", ["db/migrate"], { cwd: root });
    const wanted = files.stdout.split("\n").map((f) => /^(\d+)_.*\.rb$/.exec(f)?.[1]).filter(Boolean);
    const done = await exec("psql", ["-d", name, "-tAc", "select version from schema_migrations"], { cwd: root, timeout: 10000 }).catch(() => ({ code: 1 }));
    const ran = done.code === 0 ? new Set(done.stdout.split("\n").map((v) => v.trim()).filter(Boolean)) : null;
    const pending = ran ? wanted.filter((v) => !ran.has(v)) : null;
    const names = pending ? files.stdout.split("\n").filter((f) => pending.includes(/^(\d+)_/.exec(f)?.[1])) : [];
    return { db: name, shared: name === db.shared, pending, names };
  }

  // The terminal's script: prepare steps, maybe migrate, then the server. A shell stays
  // afterwards so the last output (a failed step, the server's exit) can be read.
  script(s, migrate) {
    const lines = [
      `gitdir=$(git rev-parse --git-dir 2>/dev/null || echo .)`,
      `prep() { name=$1; cmd=$2; shift 2; sum=$(cat "$@" 2>/dev/null | shasum | cut -c1-40); stamp="$gitdir/herdr-prepare-$name"; ` +
        `if [ "$(cat "$stamp" 2>/dev/null)" = "$sum" ]; then printf '\\033[2m· %s: up to date\\033[0m\n' "$name"; return 0; fi; ` +
        `printf '\\033[1m▸ %s\\033[0m  %s\n' "$name" "$cmd"; eval "$cmd" || return 1; printf '%s' "$sum" > "$stamp"; }`,
      `ok=1`,
    ];
    for (const step of s.prepare ?? []) {
      lines.push(`[ $ok = 1 ] && { prep ${shq(step.name)} ${shq(step.run)} ${(step.when ?? []).map(shq).join(" ")} || ok=0; }`);
    }
    if (migrate) lines.push(`[ $ok = 1 ] && { printf '\\033[1m▸ migrate\\033[0m  %s\n' ${shq(migrate)}; eval ${shq(migrate)} || ok=0; }`);
    lines.push(`if [ $ok = 1 ]; then ${s.command}; code=$?; printf '\n[%s exited: %s]\n' ${shq(s.label)} "$code"; ` +
      `else printf '\n\\033[31m[a step failed: %s not started]\\033[0m\n' ${shq(s.label)}; fi`);
    lines.push(`exec "$SHELL" -il`);
    return lines.join("\n");
  }

  // `decision` answers the shared-database question: "own" | "shared" | "skip".
  act(s, what, cx, ctx = {}) {
    if (this.busy[s.id]) return;
    this.busy[s.id] = what === "stop" ? "stopping" : "starting";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (what === "stop") await this.stopServer(s);
        else {
          const st = shared(STATE_KEY)?.[s.id];
          // Restart: where it runs now. Run here: the shown space's worktree root.
          if (what === "run" && !ctx.root && !(this.fit?.cwd === here().cwd && this.fit.ok[s.id])) throw new Error(`This worktree has no ${s.requires}.`);
          let cwd = ctx.root ?? (what === "restart" ? st?.cwd ?? st?.external?.cwd : here().cwd);
          if (!cwd) throw new Error("No folder to run it in.");
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
          if (top.code === 0) cwd = top.stdout.trim();
          // Migrations: by themselves on a worktree's own database; ask on the shared one.
          let migrate = null;
          const policy = s.migrate ?? "own-db";
          if (s.migrateCommand && policy !== "never") {
            const m = await this.migrations(s, cwd);
            const any = m && (m.pending === null || m.pending.length > 0);
            if (ctx.decision === "shared") migrate = s.migrateCommand;
            else if (ctx.decision === "own") migrate = `${s.database.makeOwn} && ${s.migrateCommand}`;
            else if (ctx.decision === "skip") migrate = null;
            else if (any && m.shared && policy === "own-db") {
              openOverlay({ mod: "dev-server", kind: "dialog", width: 460, height: 260,
                props: { role: "ask", server: s.id, what, root: cwd, info: m } });
              throw null; // asked; the dialog carries on
            } else if (any) migrate = s.migrateCommand;
          }
          if (!(await this.stopServer(s))) throw new Error(`Port ${s.port} is still in use.`);
          // A login, interactive shell: your PATH (mise, rbenv, nvm).
          const script = this.script(s, migrate);
          const r = await hcT(["run", "--bg", "--json", "--cwd", cwd, "--label", `${LABEL}=${s.id}`, "--", "/bin/zsh", "-lic", script]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
          setShared(SELECTED_KEY, s.id);
        }
      } catch (e) {
        if (e !== null) notify({ title: `${s.label}: couldn't ${what}`, body: String(e?.message ?? e), level: "error" });
      }
      delete this.busy[s.id];
      if (this.role === "head") await this.poll(cx);
      else cx.notify();
    });
  }

  button(id, t, L, label, icon, action, opts = {}) {
    const color = opts.color ?? (opts.danger ? t.blocked : t.muted);
    const greyed = opts.disabled && !opts.color;
    return h_flex().id(id).flex_none().h(24).px(8).gap(5).items_center().rounded(L ? 0 : 5).border(1)
      .border_color(opts.color ?? t.border).when(greyed, (el) => el.opacity(0.45))
      .text_color(greyed ? t.dim : color)
      .when(!opts.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action))
      .when(Boolean(opts.tooltip), (el) => el.tooltip(opts.tooltip))
      .when(Boolean(icon), (el) => el.child(svg(icon).size(11)))
      .child(L ? pixel(L, div(), 9, greyed ? t.dim : color).child(label.toUpperCase()) : div().text_size(11.5).child(label));
  }

  dot(t, st) {
    const color = st?.busy ? t.working : st?.running ? (st.external ? t.working : t.done) : t.dim;
    return div().size(7).rounded(4).flex_none().bg(color);
  }

  // What a server is doing, in words.
  status(s, st) {
    if (st?.busy) return st.busy === "stopping" ? "Stopping…" : "Starting…";
    if (st?.external) return `Running outside Herdr · ${base(st.external.cwd)}`;
    if (st?.address) return `${st.running ? "Running" : "Not listening yet"} · ${base(st.cwd)}`;
    return "Stopped";
  }

  head(t, L) {
    const state = shared(STATE_KEY) ?? {};
    const sel = this.selected();
    const st = sel ? state[sel.id] : null;
    const { cwd } = here();
    const tabs = h_flex().gap(4).items_center().children(this.servers.map((s) => {
      const on = s.id === sel?.id;
      return h_flex().id(`srv-${s.id}`).h(26).px(9).gap(6).items_center().rounded(L ? 0 : 6).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => { setShared(SELECTED_KEY, s.id); this.pointBlock(shared(STATE_KEY) ?? {}); cx.notify(); })
        .child(this.dot(t, state[s.id]))
        .child(L ? pixel(L, div(), 10, on ? t.foreground : t.muted).child(s.label.toUpperCase()) : div().text_size(12.5).child(s.label))
        .child(div().text_size(10.5).text_color(t.dim).child(`:${s.port}`));
    }));
    const runningHere = st?.address && cwd && (cwd === st.cwd || cwd.startsWith(`${st.cwd}/`));
    const fits = sel && this.fit?.cwd === cwd ? this.fit.ok[sel.id] : undefined; // undefined: still looking
    const runTip = runningHere ? `${sel.label} is running in this worktree`
      : fits === false ? `${base(cwd) || "This folder"} isn't a worktree of this app (no ${sel.requires} at its root)`
      : fits === undefined ? "Checking this worktree…"
      : st?.running ? `Stop it where it runs and start it in ${base(this.fit.root)}` : `Start in ${base(this.fit.root)}`;
    const actions = sel ? h_flex().gap(5).items_center()
      .child(this.button("srv-run", t, L, runningHere ? "Running here" : "Run here", "mods/dev-server/server.svg", (_e, cx) => this.act(sel, "run", cx),
        { disabled: Boolean(runningHere || st?.busy || fits !== true), color: runningHere ? t.done : undefined, tooltip: runTip }))
      .when(Boolean(st?.address || st?.external), (el) => el
        .child(this.button("srv-restart", t, L, "Restart", "mods/dev-server/refresh.svg", (_e, cx) => this.act(sel, "restart", cx), { disabled: Boolean(st?.busy) }))
        .child(this.button("srv-stop", t, L, "Stop", null, (_e, cx) => this.act(sel, "stop", cx), { danger: true, disabled: Boolean(st?.busy) })))
      .when(Boolean(st?.running), (el) => el.child(this.button("srv-open", t, L, "Open", "mods/dev-server/external.svg", () => exec("open", [sel.url]).catch(() => {}), { tooltip: sel.url })))
      : div();
    return v_flex().size_full().bg(t.chrome).border_b(1).border_color(t.border).px(10).pt(8).pb(8).gap(7)
      .child(h_flex().items_center().justify_between().child(tabs))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.error ?? (sel ? this.status(sel, st) : "No servers in servers.json")))
        .child(actions));
  }

  body(t, L) {
    const state = shared(STATE_KEY) ?? {};
    const sel = this.selected();
    const st = sel ? state[sel.id] : null;
    const { cwd } = here();
    if (!sel) return v_flex().size_full().bg(t.chrome);
    const title = st?.external ? `${sel.label} is running outside Herdr` : `${sel.label} isn't running`;
    const detail = st?.external
      ? `In ${st.external.cwd ?? "another terminal"} (pid ${st.external.pid}). Stop it there, or Run here to move it into Herdr.`
      : `Run here starts \`${sel.command}\` in ${base(cwd) || "this space's folder"}.`;
    return v_flex().size_full().bg(t.chrome).p(16).gap(8).items_start()
      .child(L ? pixel(L, div(), 11, L.colors.machine).child(title.toUpperCase()) : div().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.dim).child(detail));
  }

  // The shared-database question, as a dialog.
  ask(t, L) {
    const p = props();
    const s = this.servers.find((x) => x.id === p.server);
    const close = () => closeOverlay(p.overlay);
    if (!s) return v_flex().size_full().bg(t.popover);
    const m = p.info;
    const count = m.pending === null ? "Migrations may be pending" : `${m.pending.length} migration${m.pending.length === 1 ? "" : "s"} pending`;
    const choose = (decision) => () => {
      setShared(ANSWER_KEY, { server: s.id, what: p.what, root: p.root, decision, at: Date.now() });
      close();
    };
    const choice = (id, label, detail, decision, primary) => v_flex().id(id).flex_1().gap(3).p(10).rounded(L ? 0 : 6).border(1)
      .border_color(primary ? t.accent : t.border).cursor_pointer().hover((el) => el.bg(t.hover)).on_click(choose(decision))
      .child(div().text_size(12.5).font_semibold().text_color(primary ? t.accent : t.foreground).child(label))
      .child(div().text_size(11).text_color(t.dim).child(detail));
    return v_flex().size_full().bg(t.popover).p(16).gap(10)
      .child(L ? pixel(L, div(), 11, L.colors.machine).child(`${s.label}: ${count}`.toUpperCase())
        : div().text_size(14).font_semibold().text_color(t.foreground).child(`${s.label}: ${count}`))
      .child(div().text_size(12).text_color(t.muted).child(
        `${base(p.root)} uses the shared database ${m.db}. Migrating it from this branch changes it for every worktree.`))
      .when(m.names?.length > 0, (el) => el.child(div().text_size(11).font_family("JetBrains Mono").text_color(t.dim)
        .child(m.names.slice(0, 3).join("\n") + (m.names.length > 3 ? `\n+${m.names.length - 3} more` : ""))))
      .child(h_flex().gap(8)
        .child(choice("ask-own", "Own database", `Run ${s.database.makeOwn}, then migrate`, "own", true))
        .child(choice("ask-shared", "Migrate shared", `Migrate ${m.db}`, "shared"))
        .child(choice("ask-skip", "Start without", "Don't migrate", "skip")))
      .child(h_flex().justify_end().child(div().id("ask-cancel").text_size(11.5).text_color(t.dim).cursor_pointer()
        .hover((el) => el.text_color(t.foreground)).on_click(() => close()).child("Cancel")));
  }

  render() {
    const t = theme(), L = critters();
    if (this.role === "ask") return this.ask(t, L);
    return this.role === "body" ? this.body(t, L) : this.head(t, L);
  }
}
