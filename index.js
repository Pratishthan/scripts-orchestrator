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
  .option('render', {
    type: 'string',
    description: 'Render an existing results JSON file to HTML (no run). Use with --html-results.',
  })
  .option('recommend', {
    type: 'string',
    description:
      'Analyse an existing results JSON and print a memory-aware phase recommendation (no run).',
  })
  .option('fanout', {
    type: 'number',
    description: 'Workspace fan-out (parallel gates sharing the host) used to size the --recommend budget. Default 1.',
  })
  .option('mem-safety', {
    type: 'number',
    description: 'Fraction of total RAM the --recommend budget may use (default 0.8).',
  })
  .option('budget-mb', {
    type: 'number',
    description: 'Override the --recommend memory budget with a fixed value in MB.',
  })
  .option('recommend-out', {
    type: 'string',
    description: 'Write the --recommend report to this file (plain text) instead of the console.',
  })
  .help()
  .alias('h', 'help')
  .parse();

// --render mode: turn an existing results JSON into HTML and exit (no orchestration run).
// Keeps all HTML rendering in the library so consumers never reimplement it.
if (argv.render != null) {
  const { renderReportHtml } = await import('./lib/index.js');
  const srcPath = path.resolve(process.cwd(), argv.render);
  if (!fs.existsSync(srcPath)) {
    log.error(`Error: --render source not found at ${srcPath}`);
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  } catch (err) {
    log.error(`Error: failed to parse --render JSON: ${err.message}`);
    process.exit(1);
  }
  const html = renderReportHtml(payload);
  const out = argv.htmlResults ?? null;
  if (out == null || out === '-') {
    console.log(html);
  } else {
    const outPath = path.resolve(process.cwd(), out);
    const tmpPath = outPath + '.tmp';
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(tmpPath, html, 'utf8');
    fs.renameSync(tmpPath, outPath);
    log.info(`📄 Rendered ${path.relative(process.cwd(), srcPath)} → ${path.relative(process.cwd(), outPath)}`);
  }
  process.exit(0);
}

// --recommend mode: analyse an existing results JSON and print a memory-aware phase
// recommendation. Advisory only — no orchestration run. Output goes to the console, or to a
// plain-text log file when --recommend-out is given.
if (argv.recommend != null) {
  const { recommendPhases, formatRecommendationReport } = await import('./lib/index.js');
  const srcPath = path.resolve(process.cwd(), argv.recommend);
  if (!fs.existsSync(srcPath)) {
    log.error(`Error: --recommend source not found at ${srcPath}`);
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  } catch (err) {
    log.error(`Error: failed to parse --recommend JSON: ${err.message}`);
    process.exit(1);
  }
  const rec = recommendPhases(payload, {
    fanout: argv.fanout,
    memSafety: argv.memSafety,
    budgetMb: argv.budgetMb,
  });
  const report = formatRecommendationReport(rec, { sourcePath: path.relative(process.cwd(), srcPath) });
  if (argv.recommendOut != null && argv.recommendOut !== '-') {
    // Strip ANSI colour codes so the log file stays plain text. The escape char is built at runtime
    // so the regex carries no literal control character (keeps eslint's no-control-regex happy).
    const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
    const outPath = path.resolve(process.cwd(), argv.recommendOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report.replace(ansi, '') + '\n', 'utf8');
    log.info(`📄 Phase recommendation written to ${path.relative(process.cwd(), outPath)}`);
  } else {
    console.log(report);
  }
  process.exit(0);
}

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

// post-run hook — shell command run after json_results written
const postRun = commandsConfig.post_run ?? null;

// Periodic hook — shell command run on an interval WHILE the run is in flight (e.g. to roll up
// results into an aggregate report). Library owns only the cadence; the command is project-specific.
const periodicHook = commandsConfig.periodic_hook ?? null;
const periodicIntervalMs = Number(commandsConfig.periodic_interval_ms) > 0
  ? Number(commandsConfig.periodic_interval_ms)
  : 45000;

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
// wire post-run hook from config
orchestrator.postRun = postRun;
// Wire periodic hook (cadence owned by the library)
orchestrator.periodicHook = periodicHook;
orchestrator.periodicIntervalMs = periodicIntervalMs;

// Enhanced signal handlers
const handleSignal = async (signal) => {
  log.warn(`\nReceived ${signal} signal. Cleaning up...`);
  orchestrator._stopPeriodicHook();
  try {
    await orchestrator.processManager.cleanup();
  } catch (error) {
    log.error(`Cleanup failed: ${error.message}`);
  }
  // clear run-state so dashboards know the run ended
  orchestrator._clearRunState();
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
