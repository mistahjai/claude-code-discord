/**
 * Project command handlers — /project new, /project add, /project list,
 * /project remove.
 *
 * Maps Discord channels to project directories for multi-project routing:
 * Claude sessions started in a mapped channel run in that channel's project
 * directory instead of the bot's default working directory.
 *
 * /project new, /project add and /project remove are RBAC admin-only
 * (core/rbac.ts). /project list is open to any member and reveals every
 * persisted mapping as `<#channelId> → absolute path`, so treat absolute
 * paths as non-sensitive or gate this subcommand.
 *
 * @module project
 */

import { checkCommandPermission } from "../core/rbac.ts";
import type { ProjectManagerOps } from "../core/projects.ts";
import { projectCommands } from "./commands.ts";

export { projectCommands };

/** Last path segment of a resolved dir, for a default channel name */
function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || dir;
}

export interface ProjectHandlerDeps {
  /** Project manager — channel → directory mapping (core/projects.ts) */
  projects: ProjectManagerOps;
  /** Bot's default working directory (shown when a channel is unmapped) */
  defaultWorkDir: string;
  /** Create a text channel inside the bot's category and return its id.
   *  Late-bound: the Discord client exists only after the bot starts. */
  createProjectChannel?: (name: string, topic: string) => Promise<string>;
  /** Send a message into a channel the user can jump to (optional). */
  sendChannelNotice?: (channelId: string, content: string) => Promise<void>;
}

export function createProjectHandlers(deps: ProjectHandlerDeps) {
  const { projects, defaultWorkDir } = deps;

  return {
    // deno-lint-ignore no-explicit-any
    async onProject(ctx: any, subcommand: string, rawPath?: string, channelName?: string): Promise<void> {
      switch (subcommand) {
        case 'new': {
          if (!rawPath) {
            await ctx.reply({
              content: '❌ Please provide a path. Example: `/project new path:/workspace/my-repo`',
              ephemeral: true
            });
            return;
          }
          if (!(await checkCommandPermission('project-add', ctx))) return;
          if (!deps.createProjectChannel) {
            await ctx.reply({
              content: '❌ Channel creation is unavailable (bot not ready).',
              ephemeral: true
            });
            return;
          }

          try {
            // Validate the path before creating any channel — a bad path should
            // not leave an empty channel behind
            const dir = await projects.validate(rawPath);
            const name = channelName?.trim() || basename(dir);
            const createdId = await deps.createProjectChannel(
              name,
              `Project: ${dir} | Machine: ${Deno.hostname()}`,
            );
            await projects.set(createdId, dir);

            await ctx.reply({
              embeds: [{
                color: 0x00ff00,
                title: 'Project Channel Created',
                description:
                  `Created <#${createdId}> and mapped it to \`${dir}\`.\n\nOpen that channel and run \`/claude\` — sessions will run in this project.`,
                timestamp: true
              }]
            });
            await deps.sendChannelNotice?.(
              createdId,
              `📁 This channel is mapped to \`${dir}\`. Run \`/claude\` here to start a session in this project.`,
            );
          } catch (error) {
            await ctx.reply({
              content: `❌ ${error instanceof Error ? error.message : String(error)}`,
              ephemeral: true
            });
          }
          return;
        }

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
