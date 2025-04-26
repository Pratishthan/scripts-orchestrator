#!/usr/bin/env node

/**
 * @file index.js
 * @description CLI entry point for the scripts-orchestrator package
 */

import path from 'path';
import fs from 'fs';
import { Orchestrator } from './lib/index.js';
import { log } from './lib/logger.js';

// Get config file path from command line arguments
const configPath = process.argv[2] || './scripts-orchestrator.config.js';

// Validate config file exists
if (!fs.existsSync(configPath)) {
  log.error(`Error: Config file not found at ${configPath}`);
  log.error('Usage: scripts-orchestrator [path-to-config-file]');
  process.exit(1);
}

// Import the config file
const commandsConfig = (await import(path.resolve(process.cwd(), configPath))).default;

// Create and run the orchestrator
const orchestrator = new Orchestrator(commandsConfig);

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
