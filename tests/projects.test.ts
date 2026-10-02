/**
 * Unit tests for the ProjectManager path validation (multi-project routing).
 * The /project add allowlist is a security boundary: paths must be existing
 * directories that resolve under the allowlist root, with no symlink escapes.
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import * as path from "https://deno.land/std@0.208.0/path/mod.ts";
import { createProjectManager } from "../core/projects.ts";

Deno.test("resolve falls back to the default workDir for unmapped channels", () => {
  const projects = createProjectManager();
  const unmapped = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  assertEquals(projects.resolve(unmapped, "/fallback"), "/fallback");
  assertEquals(projects.resolve(undefined, "/fallback"), "/fallback");
  assertEquals(projects.resolve("", "/fallback"), "/fallback");
});

Deno.test("add validates allowlist root, persists mapping, rejects escapes", async () => {
  const tempRoot = await Deno.makeTempDir();
  const tempCwd = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  try {
    Deno.env.set("PROJECTS_ROOT", tempRoot);
    Deno.chdir(tempCwd);
    const projects = createProjectManager();

    const projectDir = path.join(tempRoot, "my-repo");
    await Deno.mkdir(projectDir);
    const realProjectDir = await Deno.realPath(projectDir);

    // Existing directory under the root → allowed, stored as realpath
    assertEquals(await projects.add("chan-1", projectDir), realProjectDir);
    assertEquals(projects.get("chan-1"), realProjectDir);

    // Mapping persisted to .bot-data/projects.json and reloaded from disk
    const persisted = JSON.parse(await Deno.readTextFile(".bot-data/projects.json"));
    assertEquals(persisted["chan-1"], realProjectDir);
    assertEquals(createProjectManager().get("chan-1"), realProjectDir);

    // Nonexistent path → rejected
    await assertRejects(() => projects.add("chan-2", path.join(tempRoot, "does-not-exist")));

    // File instead of directory → rejected
    const filePath = path.join(tempRoot, "file.txt");
    await Deno.writeTextFile(filePath, "not a directory");
    await assertRejects(() => projects.add("chan-3", filePath));

    // Resolve uses the mapping; other channels fall back
    assertEquals(projects.resolve("chan-1", "/fallback"), realProjectDir);
    assertEquals(projects.resolve("chan-unmapped", "/fallback"), "/fallback");

    // removePath unmaps every channel pointing at the path
    assertEquals(await projects.add("chan-4", projectDir), realProjectDir);
    assertEquals(await projects.removePath(projectDir), ["chan-1", "chan-4"]);
    assertEquals(projects.get("chan-1"), undefined);
    assertEquals(projects.get("chan-4"), undefined);

    // removeChannel removes a single mapping
    assertEquals(await projects.add("chan-5", projectDir), realProjectDir);
    assertEquals(projects.removeChannel("chan-5"), realProjectDir);
    assertEquals(projects.get("chan-5"), undefined);

    // Symlink escape → rejected (realpath resolves outside the root)
    if (Deno.build.os !== "windows") {
      const outside = await Deno.makeTempDir();
      try {
        const escapeLink = path.join(tempRoot, "escape");
        await Deno.symlink(outside, escapeLink);
        await assertRejects(() => projects.add("chan-6", escapeLink));
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    }
  } finally {
    Deno.chdir(originalCwd);
    Deno.env.delete("PROJECTS_ROOT");
    await Deno.remove(tempRoot, { recursive: true });
    await Deno.remove(tempCwd, { recursive: true });
  }
});

Deno.test("explicit PROJECTS_ROOT that does not exist fails loudly", () => {
  // The common Docker mistake: a host path, which does not exist inside the
  // container. Must throw at startup rather than silently becoming the allowlist.
  Deno.env.set("PROJECTS_ROOT", "/home/definitely-not-here/git");
  try {
    assertThrows(() => createProjectManager(), Error, "does not exist");
  } finally {
    Deno.env.delete("PROJECTS_ROOT");
  }
});

Deno.test("explicit PROJECTS_ROOT that is not a directory fails loudly", async () => {
  const tempRoot = await Deno.makeTempDir();
  const asFile = `${tempRoot}/not-a-dir`;
  await Deno.writeTextFile(asFile, "x");
  Deno.env.set("PROJECTS_ROOT", asFile);
  try {
    assertThrows(() => createProjectManager(), Error, "not a directory");
  } finally {
    Deno.env.delete("PROJECTS_ROOT");
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("unset PROJECTS_ROOT does not throw (native install without /project)", () => {
  Deno.env.delete("PROJECTS_ROOT");
  // Must not throw even when /workspace is absent on a native host.
  const projects = createProjectManager();
  assertEquals(projects.list().length >= 0, true);
});
