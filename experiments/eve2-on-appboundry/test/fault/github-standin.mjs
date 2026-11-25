// A LOCAL STAND-IN FOR GITHUB, for the fault-injection suite only. It is not GitHub.
//
// It serves the subset of GitHub's REST API the GitHub provider uses (issues, comments, pull requests, files, check
// runs), backed by a bare git repository the provider clones and pushes over file://. Its job is to be the external
// system that survives while the provider and the host are killed, and to count what was actually created.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Create `owner/name` as a bare repository at `root/owner/name.git` holding `files` on main. */
export function createRepository(root, repository, files) {
  const work = join(root, ".seed", repository);
  const bare = join(root, `${repository}.git`);
  rmSync(work, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git(work, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), content); }
  git(work, "add", "-A");
  git(work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  mkdirSync(join(bare, ".."), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return bare;
}

export function startStandin({ root, port }) {
  const state = { issues: [], comments: [], pulls: [], next: 1, requests: [] };
  const git = (repository, ...args) => execFileSync("git", args, { cwd: join(root, `${repository}.git`), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  const url = (repository, kind, n) => `https://standin.invalid/${repository}/${kind}/${n}`;
  const issueView = (repository, i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, html_url: url(repository, "issues", i.number), user: { login: "standin-user" }, labels: [], created_at: i.createdAt });
  const pullView = (repository, p) => ({ number: p.number, title: p.title, body: p.body, state: p.state, merged_at: null, draft: false, html_url: url(repository, "pull", p.number), head: { ref: p.head, sha: p.headSha }, base: { ref: p.base } });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const u = new URL(req.url, "http://x");
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
    state.requests.push({ method: req.method, path: u.pathname, at: Date.now() });
    if (u.pathname === "/__state") return send(200, state);
    if (u.pathname === "/user") return send(200, { login: "standin-user" });
    const m = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls|commits)(?:\/([^/]+))?(?:\/(comments|files|check-runs))?$/.exec(u.pathname);
    if (!m) return send(404, { message: "Not Found" });
    const [, repository, kind, id, sub] = m;
    try {
      if (kind === "issues" && !id && req.method === "GET") return send(200, state.issues.filter((i) => i.repository === repository).sort((a, b) => b.number - a.number).map((i) => issueView(repository, i)));
      if (kind === "issues" && !id && req.method === "POST") {
        const issue = { repository, number: state.next++, title: body.title, body: body.body, state: "open", createdAt: new Date().toISOString() };
        state.issues.push(issue);
        return send(201, issueView(repository, issue));
      }
      if (kind === "issues" && id && !sub) { const i = state.issues.find((x) => x.repository === repository && x.number === Number(id)); return i ? send(200, issueView(repository, i)) : send(404, { message: "Not Found" }); }
      if (kind === "issues" && sub === "comments" && req.method === "GET") return send(200, state.comments.filter((c) => c.repository === repository && c.issue === Number(id)).map((c) => ({ id: c.id, body: c.body, user: { login: "standin-user" }, html_url: url(repository, "issues", `${id}#c${c.id}`), created_at: c.createdAt })));
      if (kind === "issues" && sub === "comments" && req.method === "POST") {
        const c = { repository, issue: Number(id), id: state.comments.length + 1000, body: body.body, createdAt: new Date().toISOString() };
        state.comments.push(c);
        return send(201, { id: c.id, body: c.body, html_url: url(repository, "issues", `${id}#c${c.id}`) });
      }
      if (kind === "pulls" && !id && req.method === "GET") {
        const head = u.searchParams.get("head")?.split(":")[1];
        return send(200, state.pulls.filter((p) => p.repository === repository && (!head || p.head === head)).map((p) => pullView(repository, p)));
      }
      if (kind === "pulls" && !id && req.method === "POST") {
        let headSha;
        try { headSha = git(repository, "rev-parse", `refs/heads/${body.head}`); } catch { return send(422, { message: "Validation Failed: head branch does not exist" }); }
        if (state.pulls.some((p) => p.repository === repository && p.head === body.head && p.state === "open")) return send(422, { message: `A pull request already exists for ${body.head}.` });
        const p = { repository, number: state.next++, title: body.title, body: body.body, state: "open", head: body.head, headSha, base: body.base };
        state.pulls.push(p);
        return send(201, pullView(repository, p));
      }
      if (kind === "pulls" && id && !sub) { const p = state.pulls.find((x) => x.repository === repository && x.number === Number(id)); return p ? send(200, pullView(repository, p)) : send(404, { message: "Not Found" }); }
      if (kind === "pulls" && sub === "files") {
        const p = state.pulls.find((x) => x.repository === repository && x.number === Number(id));
        const lines = git(repository, "diff", "--numstat", `refs/heads/${p.base}...${p.headSha}`).split("\n").filter(Boolean);
        return send(200, lines.map((l) => { const [a, d, f] = l.split("\t"); return { filename: f, status: "modified", additions: Number(a), deletions: Number(d) }; }));
      }
      if (kind === "commits" && sub === "check-runs") return send(200, { total_count: 0, check_runs: [] });
      return send(404, { message: "Not Found" });
    } catch (error) {
      return send(500, { message: String(error.message ?? error) });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state, branches: (repository) => git(repository, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/").split("\n").filter(Boolean) })));
}
