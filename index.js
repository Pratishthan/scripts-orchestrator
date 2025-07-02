#!/usr/bin/env node

/**
 * @file index.js
 * @description CLI entry point for the scripts-orchestrator package
 */

import path from 'path';
import fs from 'fs';
import { Orchestrator } from './lib/index.js';
import { log } from './lib/logger.js';

// Parse command line arguments
const args = process.argv.slice(2);
let configPath = './scripts-orchestrator.config.js';
let startPhase = null;
let logFolder = null;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  
  if (arg === '--phase' && i + 1 < args.length) {
    startPhase = args[i + 1];
    i++; // Skip the next argument since we consumed it
  } else if (arg === '--logFolder' && i + 1 < args.length) {
    logFolder = args[i + 1];
    i++; // Skip the next argument since we consumed it
  } else if (!arg.startsWith('--') && !configPath) {
    // First non-flag argument is the config path
    configPath = arg;
  }
}

// Validate config file exists
if (!fs.existsSync(configPath)) {
  log.error(`Error: Config file not found at ${configPath}`);
  log.error('Usage: scripts-orchestrator [path-to-config-file] [--phase <phase-name>] [--logFolder <log-directory>]');
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

// Create and run the orchestrator
const orchestrator = new Orchestrator(commandsConfig, startPhase, logFolder);

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
