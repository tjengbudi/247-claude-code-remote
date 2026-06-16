import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import enquirer from 'enquirer';
import { hostname } from 'os';
import { checkAllPrerequisites, allRequiredMet } from '../lib/prerequisites.js';
import {
  createConfig,
  saveConfig,
  configExists,
  loadConfig,
  getProfilePath,
  DEFAULT_AGENT_PORT,
} from '../lib/config.js';
import { ensureDirectories, getAgentPaths } from '../lib/paths.js';
import { setupTmuxResume } from '../lib/tmux-resume.js';

export const initCommand = new Command('init')
  .description('Initialize 247 agent configuration')
  .option('-n, --name <name>', 'Machine name')
  .option('-p, --port <port>', 'Agent port')
  .option('--projects <path>', 'Projects base path', '~/Dev')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('-P, --profile <name>', 'Create or update a named profile')
  .action(async (options, cmd) => {
    // Get profile from command option or parent (global) option
    const profileName = options.profile || cmd.parent?.opts().profile;
    const profileLabel = profileName ? ` (profile: ${profileName})` : '';

    console.log(`
  ╭──────────────────────────────────╮
  │  247 - The Vibe Company          │
  │  Access Claude Code 24/7         │
  ╰──────────────────────────────────╯
`);

    // Check if config already exists
    if (configExists(profileName) && !options.force) {
      const existing = loadConfig(profileName);
      console.log(chalk.yellow(`Configuration${profileLabel} already exists:`));
      console.log(`  Machine: ${existing?.machine.name}`);
      console.log(`  Port: ${existing?.agent.port}`);
      console.log(`  Projects: ${existing?.projects.basePath}`);
      console.log('\nUse --force to overwrite.\n');
      return;
    }

    // Load existing config early so we can resolve effective port for prereq check
    // and preserve custom port on re-init (Story 3.4, AC6).
    const existing = configExists(profileName) ? loadConfig(profileName) : null;

    // Parse explicit -p once, validating it is a usable port number.
    let explicitPort: number | undefined;
    if (options.port !== undefined) {
      explicitPort = parseInt(options.port, 10);
      if (Number.isNaN(explicitPort) || explicitPort <= 0 || explicitPort > 65535) {
        console.log(chalk.red(`\nInvalid --port value: ${options.port}. Must be an integer between 1 and 65535.\n`));
        process.exit(1);
      }
    }

    // Resolve effective port: explicit -p → existing → default.
    // Pass this to prereq check; pass `undefined` to createConfig if no -p
    // so its existing?.agent?.port fallback engages.
    const effectivePort = explicitPort ?? existing?.agent?.port ?? DEFAULT_AGENT_PORT;

    // Check prerequisites
    const spinner = ora('Checking prerequisites...').start();
    const checks = await checkAllPrerequisites(effectivePort);
    spinner.stop();

    console.log(chalk.dim('Prerequisites:'));
    for (const check of checks) {
      const icon =
        check.status === 'ok'
          ? chalk.green('✓')
          : check.status === 'warn'
            ? chalk.yellow('!')
            : chalk.red('✗');
      console.log(`  ${icon} ${check.name}: ${check.message}`);
    }
    console.log();

    if (!allRequiredMet(checks)) {
      console.log(chalk.red('Please fix the errors above before continuing.\n'));
      process.exit(1);
    }

    // Gather configuration
    let machineName = options.name;
    let projectsPath = options.projects;

    if (!machineName) {
      const response = await (enquirer as any).prompt({
        type: 'input',
        name: 'machineName',
        message: 'Machine name:',
        initial: hostname(),
      });
      machineName = response.machineName;
    }

    if (!options.name) {
      const response = await (enquirer as any).prompt({
        type: 'input',
        name: 'projectsPath',
        message: 'Projects directory:',
        initial: projectsPath,
      });
      projectsPath = response.projectsPath;
    }

    // Create and save configuration
    const configSpinner = ora(`Creating configuration${profileLabel}...`).start();
    try {
      ensureDirectories();
      const config = createConfig({
        machineName,
        // Pass the validated explicit port, or undefined so createConfig's
        // existing?.agent?.port fallback engages.
        port: explicitPort,
        projectsPath,
        existing,
      });
      saveConfig(config, profileName);
      configSpinner.succeed(`Configuration${profileLabel} saved`);

      const configPath = getProfilePath(profileName);
      console.log(chalk.dim(`  → ${configPath}`));

      // Set up tmux session resume (Linux only)
      if (process.platform === 'linux') {
        try {
          const paths = getAgentPaths();
          const result = setupTmuxResume(paths.tmuxDir);
          console.log(chalk.green('  ✓ tmux session resume configured'));
          if (result.backupPath) {
            console.log(chalk.dim(`    Backed up existing ~/.tmux.conf to ${result.backupPath}`));
          }
        } catch (err) {
          console.log(chalk.yellow('  ⚠ Failed to configure tmux session resume'));
          console.log(chalk.dim(`    ${err instanceof Error ? err.message : String(err)}`));
          console.log(chalk.dim('    You can configure it manually later if needed.'));
        }
      }
    } catch (err) {
      configSpinner.fail(`Failed to create configuration: ${(err as Error).message}`);
      process.exit(1);
    }

    // Success message
    console.log(chalk.green(`\n✓ Setup${profileLabel} complete!\n`));

    console.log('Next steps:');
    if (profileName) {
      console.log(
        chalk.cyan(`  247 start --profile ${profileName}`) +
          chalk.dim('   # Start the agent with this profile')
      );
      console.log(
        chalk.cyan(`  247 profile show ${profileName}`) +
          chalk.dim('     # View profile configuration')
      );
    } else {
      console.log(chalk.cyan('  247 start                   ') + chalk.dim('# Start the agent'));
      console.log(
        chalk.cyan('  247 service install --start ') + chalk.dim('# Install as system service')
      );
    }
    console.log();
  });
