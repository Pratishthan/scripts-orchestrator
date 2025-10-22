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

// Set the log folder for the main orchestrator logs if specified
if (logFolder) {
  log.setLogFolder(logFolder);
}

// Create and run the orchestrator
const orchestrator = new Orchestrator(commandsConfig, startPhase, logFolder, phases, sequential);

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
