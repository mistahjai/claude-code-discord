/**
 * Dynamic Skill Commands — /skill (run a project skill) and /skills (list them).
 *
 * Skills and custom commands come from the Claude Code project config
 * (.claude/commands/x.md, .claude/skills/x/SKILL.md). They are discovered
 * dynamically from the SDK — no bot-side registration per skill. A skill runs
 * by sending `/<name> <args>` through the same pipeline as /claude (per-channel
 * queue, session resumption, permission mode).
 *
 * @module claude/skill-commands
 */

import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import { listSkills } from "./skill-registry.ts";

// ================================
// Command Definitions
// ================================

export const skillCommands = [
  new SlashCommandBuilder()
    .setName('skill')
    .setDescription('Run a Claude Code skill/custom command from the current project')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Skill name — type to autocomplete (see /skills)')
        .setRequired(true)
        .setMinLength(1)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('args')
        .setDescription('Arguments passed to the skill')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('skills')
    .setDescription('List available Claude Code skills in the current project'),
];

// ================================
// Handler Types & Factory
// ================================

export interface SkillCommandHandlerDeps {
  workDir: string;
  /** Same pipeline as /claude — queue, threads, session resumption, permissions */
  // deno-lint-ignore no-explicit-any
  onClaude: (ctx: any, prompt: string, channelId: string, explicitSessionId?: string) => Promise<any>;
  /** Resolve the working directory for a channel (multi-project routing). Falls back to workDir. */
  resolveWorkDir?: (channelId?: string) => string;
}

export function createSkillCommandHandlers(deps: SkillCommandHandlerDeps) {
  // Resolve the working directory for the channel (falls back to the default workDir)
  const workDirFor = (channelId?: string): string => deps.resolveWorkDir?.(channelId) ?? deps.workDir;

  return {
    /**
     * /skill — run a skill by sending `/<name> <args>` through the /claude pipeline.
     */
    // deno-lint-ignore no-explicit-any
    async onSkill(ctx: any, name: string, args?: string): Promise<void> {
      const channelId = ctx.getChannelId();
      const prompt = `/${name}${args ? ` ${args}` : ""}`;
      await deps.onClaude(ctx, prompt, channelId);
    },

    /**
     * /skills — list skills available in the channel's project.
     */
    // deno-lint-ignore no-explicit-any
    async onSkillsList(ctx: any): Promise<void> {
      await ctx.deferReply();
      const channelId = typeof ctx.getChannelId === "function" ? ctx.getChannelId() : undefined;
      const dir = workDirFor(channelId);

      try {
        const skills = await listSkills(dir, channelId);

        if (skills.length === 0) {
          await ctx.editReply({
            embeds: [{
              color: 0xffaa00,
              title: 'No skills found',
              description: `No Claude Code skills or custom commands found in \`${dir}\`.\n\nAdd \`.claude/commands/*.md\` or \`.claude/skills/*/SKILL.md\` to the project, then run this again.`,
              timestamp: true,
            }],
          });
          return;
        }

        // Conservative embed sizing (Discord total limit 6000 chars): 15 fields,
        // name ≤100, value ≤200, plus a "showing X of Y" note when truncated.
        const fields = skills.slice(0, 15).map(s => ({
          name: `/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ""}`.substring(0, 100),
          value: (s.description || 'No description').substring(0, 200),
          inline: false,
        }));
        const remaining = skills.length - fields.length;
        const description = remaining > 0
          ? `Showing ${fields.length} of ${skills.length}. Use \`/skill\` name autocomplete for the rest.`
          : undefined;

        await ctx.editReply({
          embeds: [{
            color: 0x0099ff,
            title: 'Available skills',
            description,
            fields,
            timestamp: true,
          }],
        });
      } catch (error) {
        await ctx.editReply({
          embeds: [{
            color: 0xff0000,
            title: 'Skills lookup failed',
            description: error instanceof Error ? error.message : String(error),
            timestamp: true,
          }],
        });
      }
    },
  };
}
