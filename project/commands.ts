import { SlashCommandBuilder } from "npm:discord.js@14.14.1";

export const projectCommands = [
  new SlashCommandBuilder()
    .setName('project')
    .setDescription('Manage per-channel project directories (multi-project routing)')
    .addSubcommand(sc =>
      sc.setName('new')
        .setDescription('Create a new channel in the bot category and map it to a project directory')
        .addStringOption(option =>
          option.setName('path')
            .setDescription('Absolute path to an existing directory under the allowlist root')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Channel name (default: project directory basename)')
            .setRequired(false)))
    .addSubcommand(sc =>
      sc.setName('add')
        .setDescription('Map the current channel to a project directory')
        .addStringOption(option =>
          option.setName('path')
            .setDescription('Absolute path to an existing directory under the allowlist root')
            .setRequired(true)))
    .addSubcommand(sc =>
      sc.setName('list')
        .setDescription('Show channel-to-project mappings'))
    .addSubcommand(sc =>
      sc.setName('remove')
        .setDescription('Remove a channel mapping (current channel, or all channels for a path)')
        .addStringOption(option =>
          option.setName('path')
            .setDescription('Project path to unmap across all channels (optional)')
            .setRequired(false))),
];
