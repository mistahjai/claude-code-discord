/**
 * Skill Registry — Per-channel discovery of Claude Code skills and custom commands.
 *
 * The SDK initialization response exposes `commands` ({name, description,
 * argumentHint}) for every slash command / skill loaded from the project
 * (.claude/commands/x.md, .claude/skills/x/SKILL.md). Skills captured at
 * session start are cached per channel; when no session is active, an
 * ephemeral info query discovers them for the channel's working directory.
 *
 * @module claude/skill-registry
 */

import type { SDKSlashCommand } from "./query-manager.ts";
import { fetchClaudeInfo } from "./query-manager.ts";

const DEFAULT_CHANNEL_KEY = "__default__";

/** How long a cached skill list is considered fresh (skills change rarely) */
const SKILL_CACHE_TTL_MS = 10 * 60 * 1000;

interface SkillCacheEntry {
  skills: SDKSlashCommand[];
  at: number;
}

/** Skills captured at session start, per channel/thread */
const channelSkills = new Map<string, SkillCacheEntry>();

/** Skills discovered via ephemeral query, per working directory */
const discoveredSkills = new Map<string, SkillCacheEntry>();

/** In-flight discovery per working directory, so concurrent misses share one subprocess */
const inFlightDiscovery = new Map<string, Promise<SDKSlashCommand[]>>();

function freshCache(entry: SkillCacheEntry | undefined): SDKSlashCommand[] | null {
  if (!entry) return null;
  if (Date.now() - entry.at > SKILL_CACHE_TTL_MS) return null;
  return entry.skills;
}

/**
 * Store the skills/commands reported by a session's initialization result.
 * Called from sendToClaudeCode() when a new query starts.
 */
export function setChannelSkills(commands: SDKSlashCommand[], channelId?: string): void {
  channelSkills.set(channelId || DEFAULT_CHANNEL_KEY, { skills: commands, at: Date.now() });
}

/**
 * List available skills for a channel.
 *
 * Priority: skills captured from the channel's active/recent session →
 * TTL-cached discovery for the working directory → ephemeral info query
 * (spawns a short-lived CLI subprocess, only on cache miss).
 */
export async function listSkills(workDir: string, channelId?: string): Promise<SDKSlashCommand[]> {
  const captured = freshCache(channelSkills.get(channelId || DEFAULT_CHANNEL_KEY));
  if (captured) return captured;

  const cached = freshCache(discoveredSkills.get(workDir));
  if (cached) return cached;

  // Share one ephemeral query across concurrent misses (autocomplete keystrokes
  // would otherwise each spawn their own subprocess). The promise is dropped on
  // settle, so a thrown error is retried on the next request. Note fetchClaudeInfo
  // swallows its own errors and returns null, which caches an empty list.
  let pending = inFlightDiscovery.get(workDir);
  if (!pending) {
    pending = fetchClaudeInfo(workDir, undefined, { settingSources: ['project', 'local'] })
      .then((info) => {
        const skills = info?.commands ?? [];
        discoveredSkills.set(workDir, { skills, at: Date.now() });
        return skills;
      })
      .finally(() => inFlightDiscovery.delete(workDir));
    inFlightDiscovery.set(workDir, pending);
  }

  return await pending;
}
