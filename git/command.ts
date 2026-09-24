import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import { WorktreeBotManager } from "./process-manager.ts";

export const gitCommands = [
  new SlashCommandBuilder()
    .setName('git')
    .setDescription('Execute Git command')
    .addStringOption(option =>
      option.setName('command')
        .setDescription('Git command to execute')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('worktree')
    .setDescription('Create Git worktree')
    .addStringOption(option =>
      option.setName('branch')
        .setDescription('Branch name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('ref')
        .setDescription('Reference (default: branch name)')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('worktree-list')
    .setDescription('List Git worktrees'),
  
  new SlashCommandBuilder()
    .setName('worktree-remove')
    .setDescription('Remove Git worktree')
    .addStringOption(option =>
      option.setName('branch')
        .setDescription('Branch name of worktree to remove')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('worktree-bots')
    .setDescription('List running worktree bot processes'),

  new SlashCommandBuilder()
    .setName('worktree-kill')
    .setDescription('Kill a specific worktree bot process')
    .addStringOption(option =>
      option.setName('path')
        .setDescription('Full path to worktree directory')
        .setRequired(true)),
];

export interface GitHandlerDeps {
  workDir: string;
  actualCategoryName: string;
  discordToken: string;
  applicationId: string;
  botSettings: {
    mentionEnabled: boolean;
    mentionUserId: string | null;
  };
  worktreeBotManager: WorktreeBotManager;
  /** Resolve the working directory for a channel (multi-project routing). Falls back to workDir. */
  resolveWorkDir?: (channelId?: string) => string;
}

export function createGitHandlers(deps: GitHandlerDeps) {
  const { workDir, actualCategoryName, discordToken, applicationId, botSettings, worktreeBotManager } = deps;

  // Resolve the working directory for the invoking channel (falls back to the default workDir)
  const dirFor = (ctx: any): string => {
    const channelId = typeof ctx?.getChannelId === 'function' ? ctx.getChannelId() : undefined;
    return deps.resolveWorkDir?.(channelId) ?? workDir;
  };
  
  return {
    // deno-lint-ignore no-explicit-any
    async onGit(ctx: any, command: string): Promise<string> {
      const { executeGitCommand, validateGitCommandArgs, splitGitArgs } = await import("./handler.ts");
      const validation = validateGitCommandArgs(command);
      if (!validation.valid) {
        return `Error: ${validation.reason}`;
      }
      return await executeGitCommand(dirFor(ctx), splitGitArgs(command));
    },
    
    // deno-lint-ignore no-explicit-any
    async onWorktree(ctx: any, branch: string, ref?: string) {
      const { createWorktree } = await import("./handler.ts");
      return await createWorktree(dirFor(ctx), branch, ref);
    },
    
    // deno-lint-ignore no-explicit-any
    async onWorktreeList(ctx: any) {
      const { listWorktrees } = await import("./handler.ts");
      return await listWorktrees(dirFor(ctx));
    },
    
    // deno-lint-ignore no-explicit-any
    async onWorktreeRemove(ctx: any, branch: string) {
      const { removeWorktree } = await import("./handler.ts");
      return await removeWorktree(dirFor(ctx), branch);
    },
    
    // deno-lint-ignore no-explicit-any
    async onWorktreeBot(_ctx: any, fullPath: string, branch: string) {
      await worktreeBotManager.spawnWorktreeBot({
        fullPath,
        branch,
        actualCategoryName,
        discordToken,
        applicationId,
        botSettings,
      });
    },

    // deno-lint-ignore no-explicit-any
    onWorktreeBots(_ctx: any) {
      return worktreeBotManager.getStatus();
    },

    // deno-lint-ignore no-explicit-any
    onWorktreeKill(_ctx: any, path: string): { success: boolean; message: string } {
      const success = worktreeBotManager.killWorktreeBot(path);
      return {
        success,
        message: success ? 'Worktree bot killed successfully' : 'Worktree bot not found or failed to kill'
      };
    },

    // Kill all worktree bots (used during shutdown)
    killAllWorktreeBots() {
      worktreeBotManager.killAllWorktreeBots();
    },
    
    async getStatus() {
      const { getGitStatus } = await import("./handler.ts");
      const gitStatusInfo = await getGitStatus(workDir);
      return gitStatusInfo;
    }
  };
}