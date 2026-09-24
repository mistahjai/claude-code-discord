/**
 * ProjectManager — maps Discord channel IDs to project directories.
 *
 * Enables multi-project routing: each Discord channel (or thread) can be
 * mapped to a project directory via /project add, and Claude sessions in
 * that channel run in the mapped directory instead of the bot's default
 * working directory.
 *
 * Mappings are persisted to .bot-data/projects.json (load on startup,
 * save on change).
 *
 * Security: /project add validates that the target resolves (realpath, so
 * symlinks cannot escape) to a directory under the allowlist root
 * (PROJECTS_ROOT env var, default /workspace).
 *
 * @module core/projects
 */

import * as path from "https://deno.land/std@0.208.0/path/mod.ts";

const DATA_DIR = ".bot-data";
const DATA_FILE = path.join(DATA_DIR, "projects.json");

export interface ProjectManagerOps {
  /** Get the project directory mapped to a channel (undefined if unmapped) */
  get(channelId: string): string | undefined;
  /** Resolve the working directory for a channel — mapped dir or fallback */
  resolve(channelId: string | undefined, fallback: string): string;
  /** Map a channel to a validated project directory. Returns the resolved dir. Throws on invalid path. */
  add(channelId: string, rawPath: string): Promise<string>;
  /** Remove the mapping for a channel. Returns the removed dir or undefined. */
  removeChannel(channelId: string): string | undefined;
  /** Remove all channel mappings for a path. Returns the removed channel IDs. */
  removePath(rawPath: string): Promise<string[]>;
  /** All channel → directory mappings (for /project list) */
  list(): Array<{ channelId: string; dir: string }>;
}

/**
 * Create a ProjectManager backed by .bot-data/projects.json.
 */
export function createProjectManager(): ProjectManagerOps {
  const allowlistRoot = Deno.env.get("PROJECTS_ROOT") ?? "/workspace";
  const mappings = new Map<string, string>(loadFromDisk());

  /**
   * Validate a user-provided path and return its realpath.
   * Requires an existing directory under the allowlist root. Realpath
   * resolves symlinks, so symlink escapes out of the root are rejected.
   */
  async function validateProjectPath(rawPath: string): Promise<string> {
    const resolved = path.resolve(rawPath.trim());
    const stat = await Deno.stat(resolved).catch(() => null);
    if (!stat?.isDirectory) {
      throw new Error(`Directory not found: ${resolved}`);
    }

    const real = await Deno.realPath(resolved);
    // Realpath the allowlist root too, so containment holds when the root
    // itself is reached through a symlink
    const realRoot = await Deno.realPath(allowlistRoot).catch(() => allowlistRoot);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`Path is outside the allowed root \`${allowlistRoot}\`: ${real}`);
    }

    return real;
  }

  async function save(): Promise<void> {
    try {
      await Deno.mkdir(DATA_DIR, { recursive: true });
      await Deno.writeTextFile(
        DATA_FILE,
        JSON.stringify(Object.fromEntries(mappings), null, 2) + "\n",
      );
    } catch (error) {
      console.error('[Projects] Failed to save mappings:', error);
    }
  }

  return {
    get(channelId: string): string | undefined {
      return mappings.get(channelId);
    },

    resolve(channelId: string | undefined, fallback: string): string {
      if (!channelId) return fallback;
      return mappings.get(channelId) ?? fallback;
    },

    async add(channelId: string, rawPath: string): Promise<string> {
      const dir = await validateProjectPath(rawPath);
      mappings.set(channelId, dir);
      await save();
      console.log(`[Projects] Mapped channel ${channelId} → ${dir}`);
      return dir;
    },

    removeChannel(channelId: string): string | undefined {
      const removed = mappings.get(channelId);
      if (removed === undefined) return undefined;
      mappings.delete(channelId);
      void save();
      console.log(`[Projects] Removed mapping for channel ${channelId}`);
      return removed;
    },

    async removePath(rawPath: string): Promise<string[]> {
      const resolved = path.resolve(rawPath.trim());
      // Prefer the realpath so symlinked paths match what add() stored;
      // fall back to the resolved path if the directory no longer exists
      let target = resolved;
      try {
        target = await Deno.realPath(resolved);
      } catch {
        // Directory may be gone — compare against the resolved path
      }

      const removedChannels: string[] = [];
      for (const [channelId, dir] of mappings.entries()) {
        if (dir === target) {
          mappings.delete(channelId);
          removedChannels.push(channelId);
        }
      }
      if (removedChannels.length > 0) {
        await save();
        console.log(
          `[Projects] Removed mappings for path ${target}: ${removedChannels.join(', ')}`,
        );
      }
      return removedChannels;
    },

    list(): Array<{ channelId: string; dir: string }> {
      return Array.from(mappings.entries()).map(([channelId, dir]) => ({ channelId, dir }));
    },
  };
}

/**
 * Load mappings from .bot-data/projects.json. Returns an empty map when the
 * file doesn't exist or is invalid.
 */
function loadFromDisk(): Map<string, string> {
  try {
    const raw = Deno.readTextFileSync(DATA_FILE);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'
      ),
    );
  } catch {
    // No data file yet
    return new Map();
  }
}
