#!/usr/bin/env node

/**
 * @file index.js
 * @description CLI entry point for the scripts-orchestrator package
 */

import path from 'path';
import fs from 'fs';
import { Orchestrator } from './lib/index.js';
import { log } from './lib/logger.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Run with verbose logging',
  })
  .option('phase', {
    type: 'string',
    description: 'Start execution from a specific phase',
  })
  .option('phases', {
    type: 'string',
    description: 'Comma-separated list of phases to run (for optional phases)',
  })
  .option('logFolder', {
    type: 'string',
    description: 'Specify the directory for log files',
  })
  .option('sequential', {
    type: 'boolean',
    description: 'Run all commands sequentially instead of in parallel (for low CPU machines)',
  })
  .option('force', {
    type: 'boolean',
    description: 'Force execution even if git state is unchanged',
  })
  .option('metrics', {
    type: 'string',
    description: 'Comma-separated metrics to collect and report: time, memory',
  })
  .option('json-results', {
    type: 'string',
    description: 'Write results JSON to this path; use "-" for stdout only',
  })
  .option('html-results', {
    type: 'string',
    description: 'Write HTML report to this path; use "-" for stdout only',
  })
  .help()
  .alias('h', 'help')
  .parse();

// Extract arguments
const args = argv._;
const configPath = args[0] || './scripts-orchestrator.config.js';
let startPhase = argv.phase;
let logFolder = argv.logFolder;
const phases = argv.phases ? argv.phases.split(',').map(p => p.trim()) : null;
const sequential = argv.sequential || false;
const force = argv.force || false;

const validMetrics = ['time', 'memory'];

// Validate config file exists
if (!fs.existsSync(configPath)) {
  log.error(`Error: Config file not found at ${configPath}`);
  log.error('Use --help for usage information');
  process.exit(1);
}

// Import the config file
const configFilePath = path.resolve(process.cwd(), configPath);
const fileUrl = new URL(`file://${configFilePath}`).href;
const commandsConfig = (await import(fileUrl)).default;

// Check for start_phase in config if not provided via command line
if (!startPhase && commandsConfig.start_phase) {
  startPhase = commandsConfig.start_phase;
}

// Check for log_folder in config if not provided via command line
if (!logFolder && commandsConfig.log_folder) {
  logFolder = commandsConfig.log_folder;
}

// Metrics: CLI overrides config
let metrics = [];
if (argv.metrics != null && argv.metrics !== '') {
  metrics = argv.metrics.split(',').map((m) => m.trim()).filter((m) => validMetrics.includes(m));
} else if (commandsConfig.metrics != null) {
  const fromConfig = Array.isArray(commandsConfig.metrics)
    ? commandsConfig.metrics
    : String(commandsConfig.metrics).split(',').map((m) => m.trim());
  metrics = fromConfig.filter((m) => validMetrics.includes(m));
}

// JSON results path: CLI overrides config
const jsonResultsPath =
  argv.jsonResults != null
    ? argv.jsonResults
    : (commandsConfig.json_results ?? commandsConfig.json_results_path ?? null);

// HTML results path: CLI overrides config (optional)
const htmlResultsPath =
  argv.htmlResults != null
    ? argv.htmlResults
    : (commandsConfig.html_results ?? commandsConfig.html_results_path ?? null);

// Set the log folder for the main orchestrator logs if specified
if (logFolder) {
  log.setLogFolder(logFolder);
}

// Create and run the orchestrator
const orchestrator = new Orchestrator(
  commandsConfig,
  startPhase,
  logFolder,
  phases,
  sequential,
  force,
  metrics,
  jsonResultsPath,
  htmlResultsPath,
);

// Enhanced signal handlers
const handleSignal = async (signal) => {
  log.warn(`\nReceived ${signal} signal. Cleaning up...`);
  try {
    await orchestrator.processManager.cleanup();
  } catch (error) {
    log.error(`Cleanup failed: ${error.message}`);
  }
  process.exit(1);
};

// Attach handlers for various signals
process.on('SIGINT', () => handleSignal('interrupt'));
process.on('SIGTERM', () => handleSignal('termination'));
process.on('SIGQUIT', () => handleSignal('quit'));
process.on('SIGHUP', () => handleSignal('hangup'));

// Handle uncaught exceptions and rejections
process.on('uncaughtException', async (error) => {
  log.error(`Uncaught Exception: ${error.message}`);
  await handleSignal('exception');
});

process.on('unhandledRejection', async (reason, promise) => {
  log.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  await handleSignal('rejection');
});

// Run the orchestrator
orchestrator.run();
