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
  .option('aggregate', {
    type: 'string',
    description:
      'Aggregate every npm workspace\'s results JSON into one roll-up report (no run). Pass an optional config path to override the default paths/title.',
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

// --aggregate mode: roll up every npm workspace's results JSON (plus the root run's global
// checks) into a single report. Advisory of nothing — it just renders state already on disk, so
// it is safe to fire repeatedly (e.g. from the periodic_hook while the run is in flight, or once
// at the end). No orchestration run happens here.
if (argv.aggregate != null) {
  const { writeAggregateReport } = await import('./lib/index.js');
  let options = {};
  const cfgArg = argv.aggregate;
  if (cfgArg && cfgArg !== '-') {
    const cfgPath = path.resolve(process.cwd(), cfgArg);
    if (!fs.existsSync(cfgPath)) {
      log.error(`Error: --aggregate config not found at ${cfgPath}`);
      process.exit(1);
    }
    try {
      options = (await import(new URL(`file://${cfgPath}`).href)).default ?? {};
    } catch (err) {
      log.error(`Error: failed to load --aggregate config: ${err.message}`);
      process.exit(1);
    }
  }
  // The orchestrator fires this hook a final time AFTER clearing its run-state, tagging it with
  // SCRIPTS_ORCHESTRATOR_PERIODIC=final. Honour that as an explicit "run is over" signal so the
  // final report is static (no auto-refresh) even if a stray marker lingers.
  if (process.env.SCRIPTS_ORCHESTRATOR_PERIODIC === 'final') {
    options = { ...options, inProgress: false };
  }
  try {
    const { jsonPath, htmlPath } = writeAggregateReport(options);
    if (process.env.ORCHESTRATOR_MERGE_QUIET !== '1') {
      log.info(
        `📄 Aggregated workspace report → ${path.relative(process.cwd(), jsonPath)} (+ ${path.basename(htmlPath)})`,
      );
    }
  } catch (err) {
    log.error(`Error: failed to aggregate workspace report: ${err.message}`);
    process.exit(1);
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

// Declarative npm-workspace roll-up. `aggregate: true` uses library defaults; a string loads that
// config module's default export as writeAggregateReport options; an object is used verbatim. When
// set, the library drives the workspace aggregate IN-PROCESS — the repo-root run rolls up on the
// periodic cadence + once at the end (static), and a fanned-out workspace run rolls up once as it
// finishes. This is the declarative replacement for wiring periodic_hook / post_run to shell out
// to `scripts-orchestrator --aggregate`.
let aggregateOptions = null;
const aggregateCfg = commandsConfig.aggregate;
if (aggregateCfg != null && aggregateCfg !== false) {
  if (aggregateCfg === true) {
    aggregateOptions = {};
  } else if (typeof aggregateCfg === 'string') {
    const aggCfgPath = path.resolve(process.cwd(), aggregateCfg);
    if (!fs.existsSync(aggCfgPath)) {
      log.error(`Error: aggregate config not found at ${aggCfgPath}`);
      process.exit(1);
    }
    try {
      aggregateOptions = (await import(new URL(`file://${aggCfgPath}`).href)).default ?? {};
    } catch (err) {
      log.error(`Error: failed to load aggregate config: ${err.message}`);
      process.exit(1);
    }
  } else if (typeof aggregateCfg === 'object') {
    aggregateOptions = aggregateCfg;
  }
}

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
// Wire declarative in-process workspace roll-up (takes the in-process path when set)
orchestrator.aggregateOptions = aggregateOptions;

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
  // Write one final static workspace roll-up so an interrupted run leaves a non-refreshing report
  // (only when the declarative in-process aggregate is configured; a no-op otherwise).
  if (orchestrator.aggregateOptions) {
    orchestrator._firePeriodicHookFinal();
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
