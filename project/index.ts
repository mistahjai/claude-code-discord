/**
 * Project command handlers — /project add, /project list, /project remove.
 *
 * Maps Discord channels to project directories for multi-project routing:
 * Claude sessions started in a mapped channel run in that channel's project
 * directory instead of the bot's default working directory.
 *
 * /project add and /project remove are RBAC admin-only (core/rbac.ts).
 *
 * @module project
 */

import { checkCommandPermission } from "../core/rbac.ts";
import type { ProjectManagerOps } from "../core/projects.ts";
import { projectCommands } from "./commands.ts";

export { projectCommands };

export interface ProjectHandlerDeps {
  /** Project manager — channel → directory mapping (core/projects.ts) */
  projects: ProjectManagerOps;
  /** Bot's default working directory (shown when a channel is unmapped) */
  defaultWorkDir: string;
}

export function createProjectHandlers(deps: ProjectHandlerDeps) {
  const { projects, defaultWorkDir } = deps;

  return {
    // deno-lint-ignore no-explicit-any
    async onProject(ctx: any, subcommand: string, rawPath?: string): Promise<void> {
      switch (subcommand) {
        case 'add': {
          if (!rawPath) {
            await ctx.reply({
              content: '❌ Please provide a path. Example: `/project add path:/workspace/my-repo`',
              ephemeral: true
            });
            return;
          }
          if (!(await checkCommandPermission('project-add', ctx))) return;

          try {
            const dir = await projects.add(ctx.getChannelId(), rawPath);
            await ctx.reply({
              embeds: [{
                color: 0x00ff00,
                title: 'Project Mapped',
                description: `This channel now runs Claude sessions in \`${dir}\`.`,
                timestamp: true
              }]
            });
          } catch (error) {
            await ctx.reply({
              content: `❌ ${error instanceof Error ? error.message : String(error)}`,
              ephemeral: true
            });
          }
          return;
        }

        case 'list': {
          const mappings = projects.list();
          if (mappings.length === 0) {
            await ctx.reply({
              embeds: [{
                color: 0x0099ff,
                title: 'Channel → Project Mappings',
                description: `No mappings yet. Sessions run in the default working directory \`${defaultWorkDir}\`.\n\nUse \`/project add\` to map this channel to a project.`,
                timestamp: true
              }]
            });
            return;
          }

          const lines = mappings.map(m =>
            `• <#${m.channelId}> → \`${m.dir}\``
          ).join('\n');

          await ctx.reply({
            embeds: [{
              color: 0x0099ff,
              title: 'Channel → Project Mappings',
              description: lines,
              footer: { text: `Unmapped channels fall back to ${defaultWorkDir}` },
              timestamp: true
            }]
          });
          return;
        }

        case 'remove': {
          if (!(await checkCommandPermission('project-remove', ctx))) return;

          // With a path: unmap every channel pointing at it.
          // Without: unmap the current channel only.
          if (rawPath) {
            try {
              const removedChannels = await projects.removePath(rawPath);
              if (removedChannels.length === 0) {
                await ctx.reply({
                  content: '❌ No channel mappings found for that path.',
                  ephemeral: true
                });
                return;
              }
              await ctx.reply({
                embeds: [{
                  color: 0xffaa00,
                  title: 'Project Mapping Removed',
                  description: removedChannels.map(id => `• <#${id}>`).join('\n'),
                  timestamp: true
                }]
              });
            } catch (error) {
              await ctx.reply({
                content: `❌ ${error instanceof Error ? error.message : String(error)}`,
                ephemeral: true
              });
            }
            return;
          }

          const removed = projects.removeChannel(ctx.getChannelId());
          if (!removed) {
            await ctx.reply({
              content: '❌ This channel has no project mapping.',
              ephemeral: true
            });
            return;
          }
          await ctx.reply({
            embeds: [{
              color: 0xffaa00,
              title: 'Project Mapping Removed',
              description: `This channel now falls back to the default working directory \`${defaultWorkDir}\`.`,
              timestamp: true
            }]
          });
          return;
        }

        default:
          await ctx.reply({
            content: `Unknown subcommand: ${subcommand}. Available: add, list, remove`,
            ephemeral: true
          });
      }
    },
  };
}
