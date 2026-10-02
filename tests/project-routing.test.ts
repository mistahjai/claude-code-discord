/**
 * Routing tests for per-project channel isolation.
 *
 * Guards the failure modes where a channel silently runs in the wrong project:
 *  - a thread must inherit its parent channel's mapping
 *  - an unmapped sibling channel is rejected rather than falling back to the
 *    bot's default working dir
 *  - the bot's own channel (and threads in it) stay exempt, since they're
 *    unmapped by design
 *  - /project new validates before creating a channel
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createClaudeHandlers } from "../claude/command.ts";
import { createProjectHandlers } from "../project/index.ts";
import { createProjectManager } from "../core/projects.ts";

const MAIN = "main-channel";
const SIBLING = "sibling-channel";
const THREAD_IN_MAIN = "thread-in-main";
const THREAD_IN_SIBLING = "thread-in-sibling";

const replies: string[] = [];
// deno-lint-ignore no-explicit-any
const ctx: any = {
  deferReply: () => Promise.resolve(),
  editReply: (c: unknown) => { replies.push(JSON.stringify(c)); return Promise.resolve(); },
  reply: (c: unknown) => { replies.push(JSON.stringify(c)); return Promise.resolve(); },
  followUp: () => Promise.resolve(),
  update: () => Promise.resolve(),
  getChannelId: () => MAIN,
  getString: () => null, getInteger: () => null, getBoolean: () => null,
  getSubcommand: () => null, getMemberRoleIds: () => new Set<string>(),
  getUserId: () => "u1",
};

// Mirrors index.ts: mappings + thread->parent lookups
const mappings = new Map<string, string>();
const parents: Record<string, string> = {
  [THREAD_IN_MAIN]: MAIN,
  [THREAD_IN_SIBLING]: SIBLING,
};
const resolveProjectDir = (id?: string): string | undefined => {
  if (!id) return undefined;
  const direct = mappings.get(id);
  if (direct) return direct;
  const p = parents[id];
  return p ? mappings.get(p) : undefined;
};
const usesDefaultWorkDir = (id?: string) => id === MAIN || id === THREAD_IN_MAIN;

const sessionDirs = new Map<string, string>();
const h = createClaudeHandlers({
  workDir: "/workspace",
  resolveWorkDir: (id?: string) => resolveProjectDir(id) ?? "/workspace",
  resolveProjectDir,
  usesDefaultWorkDir,
  getClaudeController: () => null,
  setClaudeController: () => {},
  getSessionForChannel: (c: string) => sessionDirs.get("sess:" + c),
  setSessionForChannel: (c: string, s: string | undefined, actualDir?: string) => {
    if (s) sessionDirs.set("sess:" + c, s); else sessionDirs.delete("sess:" + c);
    if (s && actualDir) dirsBySession.set(s, actualDir);
  },
  getWorkDirForSession: (s: string) => dirsBySession.get(s),
  getClaudeSessionId: () => undefined,
  setClaudeSessionId: () => {},
  sendClaudeMessages: async () => {},
});
const dirsBySession = new Map<string, string>();

Deno.test("thread inherits parent channel's project", () => {
  mappings.set(SIBLING, "/workspace/kindle-feeder");
  assertEquals(resolveProjectDir(THREAD_IN_SIBLING), "/workspace/kindle-feeder");
  mappings.clear();
});

Deno.test("unmapped sibling channel is rejected with a hint", async () => {
  replies.length = 0;
  const res = await h.onClaude(ctx, "hi", SIBLING);
  assertStringIncludes(res.response, "no project mapped");
  assertStringIncludes(replies.join(""), "project add");
});

Deno.test("bot main channel and its threads are never rejected", async () => {
  // these DO proceed to the SDK, so only assert the guard didn't fire
  const r1 = await Promise.race([h.onClaude(ctx, "x", MAIN).catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 400))]);
  const r2 = await Promise.race([h.onClaude(ctx, "x", THREAD_IN_MAIN).catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 400))]);
  assertEquals(JSON.stringify(r1).includes("no project mapped"), false);
  assertEquals(JSON.stringify(r2).includes("no project mapped"), false);
});

Deno.test("a thread in a MAPPED sibling channel is allowed", async () => {
  mappings.set(SIBLING, "/workspace/kindle-feeder");
  const r = await Promise.race([h.onClaude(ctx, "x", THREAD_IN_SIBLING).catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 400))]);
  assertEquals(JSON.stringify(r).includes("no project mapped"), false);
  mappings.clear();
});

Deno.test("/project new validates path, creates channel, maps it", async () => {
  const root = await Deno.makeTempDir();
  const repo = `${root}/my-repo`;
  await Deno.mkdir(repo);
  Deno.env.set("PROJECTS_ROOT", root);
  const pm = createProjectManager();
  const created: string[] = [];
  const ph = createProjectHandlers({
    projects: pm,
    defaultWorkDir: "/workspace",
    createProjectChannel: (name) => { created.push(name); return Promise.resolve("new-chan-id"); },
    sendChannelNotice: () => Promise.resolve(),
  });
  replies.length = 0;
  const reply = (c: unknown) => { replies.push(JSON.stringify(c)); return Promise.resolve(); };
  await ph.onProject({ ...ctx, reply }, "new", repo);
  assertEquals(created.length, 1);
  assertEquals(created[0], "my-repo");
  assertEquals(pm.get("new-chan-id"), repo);
  // bad path must NOT create a channel
  created.length = 0;
  replies.length = 0;
  await ph.onProject({ ...ctx, reply }, "new", "/etc");
  assertEquals(created.length, 0);
  assertStringIncludes(replies.join(""), "allowed root");
  Deno.env.delete("PROJECTS_ROOT");
  await Deno.remove(root, { recursive: true });
});
