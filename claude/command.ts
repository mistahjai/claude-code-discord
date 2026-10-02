import type { ClaudeResponse, ClaudeMessage } from "./types.ts";
import { createClaudeSender, type DiscordSender } from "./discord-sender.ts";
import { sendToClaudeCode, type ClaudeModelOptions } from "./client.ts";
import { convertToClaudeMessages } from "./message-converter.ts";
import {
  tryEnqueueClaudeJob,
  takeClaudeJob,
  clearClaudeJob,
} from "./channel-queue.ts";
import {
  buildSessionFooter,
  cancelClaudeComponents,
  claudeCancelledEmbed,
  resolveThreadChannelId,
} from "./status-embed.ts";
import { EMBED_COLORS } from "../discord/embed-theme.ts";
import { SlashCommandBuilder } from "npm:discord.js@14.14.1";

// Callback that creates (or retrieves) a session thread and returns a
// sender function bound to that thread.
export interface SessionThreadCallbacks {
  /**
   * Create a new Discord thread for this session and return a sender bound to it.
   * Also posts a summary embed in the main channel linking to the thread.
   *
   * @param prompt The user's prompt (used to name the thread)
   * @param sessionId Optional pre-existing session ID (reuses thread if one exists)
   * @returns Object with the thread-bound sender and a placeholder session key
   */
  createThreadSender(prompt: string, sessionId?: string, threadName?: string): Promise<{
    sender: (messages: ClaudeMessage[]) => Promise<void>;
    threadSessionKey: string;
    threadChannelId: string;
  }>;
  /**
   * Look up an existing thread for a session (does NOT create one).
   * Returns undefined if the session has no thread.
   */
  getThreadSender(sessionId: string): Promise<{
    sender: (messages: ClaudeMessage[]) => Promise<void>;
    threadSessionKey: string;
  } | undefined>;
  /**
   * Update the session key mapping when the real SDK session ID arrives.
   */
  updateSessionId(oldKey: string, newSessionId: string): void;
  /** Discord thread channel id for a session, if tracked. */
  getThreadChannelId(sessionId: string): string | undefined;
  /** Session id for a Discord thread channel, if tracked. */
  findSessionByThreadId(threadId: string): string | undefined;
}

// Discord command definitions
export const claudeCommands = [
  new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Send message to Claude Code (auto-continues in current channel)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('session_id')
        .setDescription('Session ID to resume (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-thread')
    .setDescription('Start a new Claude session in a dedicated thread')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Thread name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the Claude session active in this channel')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-cancel')
    .setDescription('Cancel currently running Claude Code command (also available as Cancel on the running embed)'),
];

export interface ClaudeHandlerDeps {
  workDir: string;
  getClaudeController: (channelId?: string) => AbortController | null;
  setClaudeController: (controller: AbortController | null, channelId?: string) => void;
  /** Get session ID for a specific channel/thread (per-channel tracking) */
  getSessionForChannel: (channelId: string) => string | undefined;
  /** Set session ID for a specific channel/thread. Pass `actualDir` (the dir the
   *  session ran in) so thread sessions record their parent's project, not the fallback. */
  setSessionForChannel: (channelId: string, sessionId: string | undefined, actualDir?: string) => void;
  /** Project dir a session was started in (undefined if the session is unknown here) */
  getWorkDirForSession?: (sessionId: string) => string | undefined;
  /** Legacy global getter (for /resume — find most recent across channels) */
  getClaudeSessionId: () => string | undefined;
  /** Legacy global setter (keeps backward compat for session manager) */
  setClaudeSessionId: (sessionId: string | undefined) => void;
  /** Default sender — used when no thread is available (fallback) */
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  /** Get current runtime options from unified settings (thinking, operation, proxy) */
  getQueryOptions?: () => ClaudeModelOptions;
  /** Thread-per-session callbacks (optional — when absent, falls back to main channel) */
  sessionThreads?: SessionThreadCallbacks;
  /** Resolve the working directory for a channel (multi-project routing). Falls back to workDir. */
  resolveWorkDir?: (channelId?: string) => string;
  /** Resolve a channel/thread to its mapped project dir, or undefined if unmapped.
   *  Threads inherit their parent channel's mapping. */
  resolveProjectDir?: (channelId?: string) => string | undefined;
  /** True when a channel/thread should legitimately use the bot's default
   *  workDir: the bot's own channel and threads directly inside it. Those are
   *  unmapped by design, so the unmapped-channel guard must not fire on them. */
  usesDefaultWorkDir?: (channelId?: string) => boolean;
  /** Sender bound to a specific channel, so a session started outside the bot's
   *  own channel replies there instead of streaming into the main channel.
   *  Return undefined to keep the default (main channel) sender. */
  getChannelSender?: (channelId?: string) => DiscordSender | undefined;
}

export function createClaudeHandlers(deps: ClaudeHandlerDeps) {
  const { workDir, sendClaudeMessages } = deps;

  function threadIdFor(sessionId?: string, channelId?: string, knownThreadChannelId?: string): string | undefined {
    return resolveThreadChannelId({
      sessionId,
      channelId,
      knownThreadChannelId,
      getThreadChannelId: deps.sessionThreads?.getThreadChannelId.bind(deps.sessionThreads),
      findSessionByThreadId: deps.sessionThreads?.findSessionByThreadId.bind(deps.sessionThreads),
    });
  }

  // A brand-new session has no thread yet, so the default sender would stream the
  // whole reply into the bot's main channel. Fall back to the channel the command
  // was issued in — that is where the user is actually looking.
  function useChannelSenderIfNoThread(
    sender: (messages: ClaudeMessage[]) => Promise<void>,
    channelId: string,
  ): (messages: ClaudeMessage[]) => Promise<void> {
    if (sender !== sendClaudeMessages) return sender;
    const channelSender = deps.getChannelSender?.(channelId);
    return channelSender ? createClaudeSender(channelSender) : sender;
  }

  // deno-lint-ignore no-explicit-any
  async function runClaudeJob(
    ctx: any,
    prompt: string,
    channelId: string,
    explicitSessionId: string | undefined,
    alreadyDeferred: boolean,
  ): Promise<ClaudeResponse> {
    const controller = new AbortController();
    deps.setClaudeController(controller, channelId);
    const dir = deps.resolveWorkDir?.(channelId) ?? workDir;

    try {
      if (!alreadyDeferred) {
        await ctx.deferReply();
      }

      // Resolve which session to resume:
      // 1) Explicit session_id from user → resume that
      // 2) Active session in this channel/thread → resume that
      // 3) None → start a new session
      const activeSessionId = explicitSessionId || deps.getSessionForChannel(channelId);

      let activeSender = sendClaudeMessages;
      if (activeSessionId && deps.sessionThreads) {
        try {
          const existing = await deps.sessionThreads.getThreadSender(activeSessionId);
          if (existing) {
            activeSender = existing.sender;
          }
        } catch { /* fallback to main sender */ }
      }
      activeSender = useChannelSenderIfNoThread(activeSender, channelId);

      const isResuming = !!activeSessionId;
      const runningThreadId = threadIdFor(activeSessionId, channelId);

      await ctx.editReply({
        embeds: [{
          color: EMBED_COLORS.running,
          title: isResuming ? '/claude · continuing' : '/claude · running',
          description: isResuming ? 'Continuing session...' : 'Starting new session...',
          fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          footer: buildSessionFooter(activeSessionId, runningThreadId),
          timestamp: true,
        }],
        components: cancelClaudeComponents(),
      });

      let result: ClaudeResponse;
      try {
        result = await sendToClaudeCode(
          dir,
          prompt,
          controller,
          activeSessionId,
          undefined,
          (jsonData) => {
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              activeSender(claudeMessages).catch(() => {});
            }
          },
          false,
          { ...deps.getQueryOptions?.(), channelId },
        );
      } catch (err) {
        if (controller.signal.aborted) {
          try {
            await ctx.editReply({
              embeds: [claudeCancelledEmbed()],
              components: [],
            });
          } catch { /* button handler may have already updated */ }
          return { response: 'Cancelled' };
        }
        throw err;
      }

      if (controller.signal.aborted) {
        try {
          await ctx.editReply({
            embeds: [claudeCancelledEmbed()],
            components: [],
          });
        } catch { /* ignore */ }
        return { response: 'Cancelled', sessionId: result.sessionId };
      }

      if (result.sessionId) {
        deps.setSessionForChannel(channelId, result.sessionId, dir);
      }
      deps.setClaudeSessionId(result.sessionId);

      const doneThreadId = threadIdFor(result.sessionId, channelId, runningThreadId);
      try {
        await ctx.editReply({
          embeds: [{
            color: EMBED_COLORS.success,
            title: '/claude · done',
            description: 'Response posted above. Use `/claude` to continue in this channel.',
            fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
            footer: buildSessionFooter(result.sessionId, doneThreadId),
            timestamp: true,
          }],
          components: [],
        });
      } catch { /* interaction may have expired */ }

      return result;
    } finally {
      deps.setClaudeController(null, channelId);

      // Drain one queued /claude for this channel (max depth 1)
      const next = takeClaudeJob(channelId);
      if (next) {
        void runClaudeJob(
          next.ctx,
          next.prompt,
          channelId,
          next.explicitSessionId,
          true, // queued jobs already deferred
        ).catch((err) => {
          console.error('[ClaudeQueue] Failed to run queued job:', err);
          try {
            // deno-lint-ignore no-explicit-any
            (next.ctx as any).editReply?.({
              embeds: [{
                color: EMBED_COLORS.fail,
                title: '/claude · queue failed',
                description: err instanceof Error ? err.message : String(err),
                timestamp: true,
              }],
              components: [],
            });
          } catch { /* interaction may have expired */ }
        });
      }
    }
  }

  // Reject running Claude in a channel with no project mapping. Without this,
  // an unmapped sibling channel silently runs in the bot's default workDir
  // (often the mount root). Returns true if the caller should abort.
  // Skipped for the bot's own channel/threads, which use workDir by design.
  // deno-lint-ignore no-explicit-any
  async function rejectIfUnmapped(ctx: any, channelId: string): Promise<boolean> {
    if (!deps.resolveProjectDir || !deps.usesDefaultWorkDir) return false;
    if (deps.resolveProjectDir(channelId)) return false;
    if (deps.usesDefaultWorkDir(channelId)) return false;
    await ctx.reply({
      embeds: [{
        color: EMBED_COLORS.info,
        title: '/claude · no project mapped',
        description:
          'This channel has no project directory mapped, so Claude would run in the bot\'s default working directory.\n\nMap this channel first:\n`/project add path:<dir>`',
        timestamp: true,
      }],
    });
    return true;
  }

  return {
    /**
     * /claude — Send a message to Claude. Auto-continues the session active in the
     * current channel/thread. Starts a new session only if there isn't one yet.
     * Same-channel: one waiting slot (queue); if full, busy-reject.
     * (continue/thread/enhanced still abort-replace — not queued.)
     */
    // deno-lint-ignore no-explicit-any
    async onClaude(ctx: any, prompt: string, channelId: string, explicitSessionId?: string): Promise<ClaudeResponse> {
      if (await rejectIfUnmapped(ctx, channelId)) {
        return { response: 'Rejected: no project mapped for this channel.' };
      }
      // A session ID belongs to the project (cwd) it ran in. Resuming it here
      // would replay another project's transcript under this channel's cwd.
      if (explicitSessionId) {
        const sessionDir = deps.getWorkDirForSession?.(explicitSessionId);
        const currentDir = deps.resolveWorkDir?.(channelId) ?? workDir;
        if (sessionDir && sessionDir !== currentDir) {
          await ctx.reply({
            embeds: [{
              color: EMBED_COLORS.fail,
              title: '/claude · different project',
              description: `That session belongs to \`${sessionDir}\`, but this channel runs in \`${currentDir}\`. Start a new session here, or run it in <#${channelId}> of that project.`,
              timestamp: true,
            }],
          });
          return { response: 'Rejected: session belongs to a different project.' };
        }
      }

      const existingController = deps.getClaudeController(channelId);
      if (existingController) {
        const enqueued = tryEnqueueClaudeJob(channelId, {
          ctx,
          prompt,
          explicitSessionId,
          enqueuedAt: Date.now(),
        });
        if (enqueued) {
          await ctx.deferReply();
          const queuedSessionId = explicitSessionId || deps.getSessionForChannel(channelId);
          await ctx.editReply({
            embeds: [{
              color: EMBED_COLORS.info,
              title: '/claude · queued',
              description:
                'A Claude session is already running in this channel. Your prompt will run next when it finishes. Use Cancel or `/claude-cancel` to abort the current run and drop the queue.',
              fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
              footer: buildSessionFooter(queuedSessionId, threadIdFor(queuedSessionId, channelId)),
              timestamp: true,
            }],
            components: cancelClaudeComponents(),
          });
          return { response: 'Queued — will run when the current session finishes.' };
        }

        await ctx.reply({
          embeds: [{
            color: EMBED_COLORS.running,
            title: '/claude · busy',
            description:
              'A Claude session is already running and one prompt is already queued. Use Cancel on the running embed or `/claude-cancel`, then try again.',
            timestamp: true,
          }],
        });
        return { response: 'A Claude session is already running in this channel (queue full).' };
      }

      return await runClaudeJob(ctx, prompt, channelId, explicitSessionId, false);
    },

    /**
     * /claude-thread — Start a brand-new session in a dedicated Discord thread.
     */
    // deno-lint-ignore no-explicit-any
    async onClaudeThread(ctx: any, prompt: string, threadName?: string): Promise<ClaudeResponse> {
      const parentChannelId = typeof ctx.getChannelId === 'function' ? ctx.getChannelId() : undefined;
      if (parentChannelId && await rejectIfUnmapped(ctx, parentChannelId)) {
        return { response: 'Rejected: no project mapped for this channel.' };
      }
      // New threads have no project mapping — inherit the invoking channel's project
      const dir = deps.resolveWorkDir?.(parentChannelId) ?? workDir;

      // Register/abort immediately so cancel works during defer + thread creation
      if (parentChannelId) {
        const existingController = deps.getClaudeController(parentChannelId);
        if (existingController) {
          existingController.abort();
        }
      }
      const controller = new AbortController();
      if (parentChannelId) {
        deps.setClaudeController(controller, parentChannelId);
      }

      await ctx.deferReply();

      // Create a dedicated thread for this session
      let activeSender = sendClaudeMessages;
      let threadSessionKey: string | undefined;
      let threadChannelId: string | undefined;

      if (deps.sessionThreads) {
        try {
          const threadResult = await deps.sessionThreads.createThreadSender(prompt, undefined, threadName);
          activeSender = threadResult.sender;
          threadSessionKey = threadResult.threadSessionKey;
          threadChannelId = threadResult.threadChannelId;
        } catch (err) {
          console.warn('[SessionThread] Could not create thread, falling back to main channel:', err);
        }
      }

      const channelId = threadChannelId || parentChannelId;
      // Thread creation failed → reply in the channel it was issued from, not #main
      activeSender = useChannelSenderIfNoThread(activeSender, channelId);
      // Rebind controller to the thread channel so cancel inside the thread hits the right key
      if (threadChannelId && parentChannelId && threadChannelId !== parentChannelId) {
        deps.setClaudeController(null, parentChannelId);
        deps.setClaudeController(controller, threadChannelId);
      }

      try {
        await ctx.editReply({
          embeds: [{
            color: EMBED_COLORS.running,
            title: '/claude-thread · running',
            description: threadSessionKey
              ? 'Session started in a dedicated thread — check below ↓'
              : 'Starting new session...',
            fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
            footer: buildSessionFooter(undefined, threadChannelId),
            timestamp: true,
          }],
          components: cancelClaudeComponents(),
        });

        let result: ClaudeResponse;
        try {
          result = await sendToClaudeCode(
            dir,
            prompt,
            controller,
            undefined, // always a new session
            undefined,
            (jsonData) => {
              const claudeMessages = convertToClaudeMessages(jsonData);
              if (claudeMessages.length > 0) {
                activeSender(claudeMessages).catch(() => {});
              }
            },
            false,
            { ...deps.getQueryOptions?.(), channelId },
          );
        } catch (err) {
          if (controller.signal.aborted) {
            try {
              await ctx.editReply({
                embeds: [claudeCancelledEmbed()],
                components: [],
              });
            } catch { /* ignore */ }
            return { response: 'Cancelled' };
          }
          throw err;
        }

        if (controller.signal.aborted) {
          try {
            await ctx.editReply({
              embeds: [claudeCancelledEmbed()],
              components: [],
            });
          } catch { /* ignore */ }
          return { response: 'Cancelled', sessionId: result.sessionId };
        }

        deps.setClaudeSessionId(result.sessionId);

        // Map the thread channel → session so /claude inside the thread auto-continues
        if (threadSessionKey && result.sessionId && deps.sessionThreads) {
          deps.sessionThreads.updateSessionId(threadSessionKey, result.sessionId);
        }
        if (threadChannelId && result.sessionId) {
          deps.setSessionForChannel(threadChannelId, result.sessionId, dir);
        }

        try {
          await ctx.editReply({
            embeds: [{
              color: EMBED_COLORS.success,
              title: '/claude-thread · done',
              description: threadChannelId
                ? `Session running in <#${threadChannelId}>.`
                : 'Response posted above.',
              fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
              footer: buildSessionFooter(result.sessionId, threadChannelId),
              timestamp: true,
            }],
            components: [],
          });
        } catch { /* ignore */ }

        return result;
      } finally {
        if (channelId) {
          deps.setClaudeController(null, channelId);
        }
      }
    },

    /**
     * /resume — Continue the session active in this channel/thread.
     * Falls back to the bot-wide last session only when this channel has none.
     */
    // deno-lint-ignore no-explicit-any
    async onContinue(ctx: any, prompt?: string): Promise<ClaudeResponse> {
      const channelId = typeof ctx.getChannelId === 'function' ? ctx.getChannelId() : undefined;
      if (channelId && await rejectIfUnmapped(ctx, channelId)) {
        return { response: 'Rejected: no project mapped for this channel.' };
      }
      const existingController = deps.getClaudeController(channelId);
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller, channelId);
      const dir = deps.resolveWorkDir?.(channelId) ?? workDir;
      // Channel-scoped first, so resuming here never adopts another
      // channel's session (and its thread).
      const channelSessionId = channelId ? deps.getSessionForChannel(channelId) : undefined;
      const resumeSessionId = channelSessionId ?? deps.getClaudeSessionId();

      try {
        const actualPrompt = prompt || "Please continue.";

        await ctx.deferReply();

        // Reuse this channel's session thread if it has one
        let activeSender = sendClaudeMessages;
        let isReusingThread = false;

        if (deps.sessionThreads && resumeSessionId) {
          try {
            const existing = await deps.sessionThreads.getThreadSender(resumeSessionId);
            if (existing) {
              activeSender = existing.sender;
              isReusingThread = true;
            }
          } catch (err) {
            console.warn('[SessionThread] Could not reuse thread for continue, falling back:', err);
          }
        }

        // No reusable thread → reply in the issuing channel, not #main
        activeSender = useChannelSenderIfNoThread(activeSender, channelId);

        const resumeThreadId = threadIdFor(resumeSessionId, channelId);

        await ctx.editReply({
          embeds: [{
            color: EMBED_COLORS.running,
            title: '/resume · continuing',
            description: isReusingThread
              ? 'Continuing in session thread...'
              : 'Loading latest conversation and waiting for response...',
            fields: prompt
              ? [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }]
              : undefined,
            footer: buildSessionFooter(resumeSessionId, resumeThreadId),
            timestamp: true,
          }],
          components: cancelClaudeComponents(),
        });

        let result: ClaudeResponse;
        try {
          result = await sendToClaudeCode(
            dir,
            actualPrompt,
            controller,
            undefined,
            undefined,
            (jsonData) => {
              const claudeMessages = convertToClaudeMessages(jsonData);
              if (claudeMessages.length > 0) {
                activeSender(claudeMessages).catch(() => {});
              }
            },
            true, // continueMode = true
            { ...deps.getQueryOptions?.(), channelId },
          );
        } catch (err) {
          if (controller.signal.aborted) {
            try {
              await ctx.editReply({
                embeds: [claudeCancelledEmbed()],
                components: [],
              });
            } catch { /* ignore */ }
            return { response: 'Cancelled' };
          }
          throw err;
        }

        if (controller.signal.aborted) {
          try {
            await ctx.editReply({
              embeds: [claudeCancelledEmbed()],
              components: [],
            });
          } catch { /* ignore */ }
          return { response: 'Cancelled', sessionId: result.sessionId };
        }

        // Claim the continued session for this channel so a later /claude or
        // /resume here routes to the same transcript and thread
        if (channelId && result.sessionId) {
          deps.setSessionForChannel(channelId, result.sessionId, dir);
        }
        deps.setClaudeSessionId(result.sessionId);

        try {
          await ctx.editReply({
            embeds: [{
              color: EMBED_COLORS.success,
              title: '/resume · done',
              description: 'Response posted above. Use `/resume` or `/claude` to continue.',
              fields: prompt
                ? [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }]
                : undefined,
              footer: buildSessionFooter(
                result.sessionId,
                threadIdFor(result.sessionId, channelId, resumeThreadId),
              ),
              timestamp: true,
            }],
            components: [],
          });
        } catch { /* ignore */ }

        return result;
      } finally {
        deps.setClaudeController(null, channelId);
      }
    },

    // deno-lint-ignore no-explicit-any
    onClaudeCancel(ctx: any): boolean {
      const channelId = typeof ctx?.getChannelId === 'function' ? ctx.getChannelId() : undefined;
      const currentController = deps.getClaudeController(channelId);
      const dropped = channelId ? clearClaudeJob(channelId) : undefined;

      if (dropped) {
        try {
          // deno-lint-ignore no-explicit-any
          (dropped.ctx as any).editReply?.({
            embeds: [{
              color: EMBED_COLORS.fail,
              title: '/claude · queue cancelled',
              description: 'Queued prompt was dropped because Cancel or `/claude-cancel` was used.',
              timestamp: true,
            }],
            components: [],
          });
        } catch { /* interaction may have expired */ }
      }

      if (!currentController && !dropped) {
        return false;
      }

      if (currentController) {
        console.log("Cancelling Claude Code session...");
        currentController.abort();
        deps.setClaudeController(null, channelId);
      }

      // Clear only this channel's session; leave global alone unless it belongs here
      if (channelId) {
        const channelSession = deps.getSessionForChannel(channelId);
        deps.setSessionForChannel(channelId, undefined);
        if (channelSession && deps.getClaudeSessionId() === channelSession) {
          deps.setClaudeSessionId(undefined);
        }
      }

      return true;
    }
  };
}
