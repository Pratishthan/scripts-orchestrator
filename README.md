# Scripts Orchestrator

A powerful script orchestrator for running parallel commands with dependency management, background processes, and health checks. Perfect for CI/CD pipelines and automated testing workflows.

## Why?
I don't have access to a mature CI/CD solution. As the project grows, I have added several scripts to my package.json which I need to run as sanity. Ex: `build, test, lint, test-storybook, playwright, stylelint` etc. I wanted a script that 


* would run the commands specified in my package in parallel
* be OS agnostic
* start & stop any dependencies
* keep the terminal clean
* log in the right places
* give me a clear go/no-go indication at the end

There don't seem to be any existing npm packages that meet my needs so I wrote one. 

## Installation

```bash
# Install as a development dependency
npm install --save-dev scripts-orchestrator

```

## Features

- **Parallel Execution**: Runs multiple commands concurrently for faster execution
- **Concurrency cap**: Bound how many commands a phase runs at once with `max_concurrency` / `--max-concurrency` (defaults to `auto` = CPU count − 1) so smaller machines aren't asked to host every command's toolchain simultaneously (v3.6+). A single phase can pin its own cap with a phase-level `max_concurrency` — e.g. `1` to serialise just that phase's commands while continuing past failures (v3.7+)
- **Sequential Mode**: Option to run all commands sequentially for low CPU machines
- **Dependency Management**: Handles command dependencies and ensures proper execution order
- **Background Processes**: Supports running commands in the background with health checks
- **Retry Mechanism**: Configurable retry attempts for failed commands
- **Process Management**: Proper cleanup of background processes
- **Health Checks**: Verifies service availability before proceeding
- **Environment Variables**: Pass custom environment variables to commands
- **Optional Phases**: Mark phases as optional and run them selectively
- **Git-Based Caching**: Automatically skips execution when git state is unchanged
- **Comprehensive Logging**: Detailed logging of command execution and results
- **Incremental JSON results**: Live-updating `json_results` file as commands complete (v2.14+)
- **NDJSON event stream**: Machine-readable per-command events for dashboards (v2.14+)
- **Post-run hook**: Run a shell command after results are written via `post_run` config (v2.14+)
- **Run-state file**: Library-owned in-progress indicator for live dashboard integration (v2.14+)
- **Phase recommendations**: Resource-aware `--recommend` mode that proposes an optimal phase layout from a run's time/memory/CPU metrics, packing under both a memory budget and the host's CPU core share. Accepts either a single-scope results JSON or a whole-monorepo roll-up report, pooling every workspace's commands into one cross-scope recommendation (advisory, v2.15+)
- **Per-command metrics**: Record `durationMs`, peak `memoryKb`, and average `cpuPercent` per command via `metrics: ['time', 'memory', 'cpu']` (CPU axis v3.8+)
- **npm workspace aggregation**: First-class workspace roll-up that discovers the npm workspaces in a repo and rolls each workspace's results JSON — plus the root run's global checks — into a single report. Drive it declaratively with the `aggregate` config key (in-process; v3.2+) or via the standalone `--aggregate` CLI mode (v3.1+)

## Configuration

Create a configuration file (default: `scripts-orchestrator.config.js`) that defines an array of commands to execute. Each command can have the following properties:

```javascript
{
  command: 'command_name',           // The command to run (see "Command prefix" below)
  description: 'Description',        // Optional description
  status: 'enabled',                 // 'enabled' or 'disabled'
  attempts: 1,                       // Number of retry attempts
  dependencies: [],                 // Array of dependent commands
  background: false,                // Whether to run in background
  shell: false,                     // true => run `command` verbatim as a shell command (no prefix)
  prefix: 'npm run',                // Optional per-command prefix override ('' to disable)
  env: {                            // Optional environment variables
    PORT: 3000,
    NODE_ENV: 'production'
  },
  kill_command: 'kill_storybook',   // Optional kill command to kill the process
  health_check: {                   // Health check configuration
    url: 'http://localhost:port',
    max_attempts: 20,
    interval: 2000
  },
  should_retry: (output) => {    // Custom retry logic
    // Return true to retry, false to skip
  }
}
```

### Command prefix (`npm run` is optional)

By default every `command` is run as an npm script — the orchestrator prepends `npm run`,
so `command: 'build'` executes `npm run build`. This prefix is configurable:

- **Global default** — set `command_prefix` at the top level of the config. Use it to point at a
  different runner (`'pnpm run'`, `'yarn'`) or to disable prefixing entirely so commands run as
  regular shell commands:

  ```javascript
  export default {
    command_prefix: '',              // '' / false / null => run commands verbatim (plain shell)
    phases: [
      { name: 'checks', parallel: [
        { command: 'eslint . --max-warnings 0' },   // runs as-is, supports args/pipes/&&
        { command: './scripts/verify.sh' },
      ]},
    ],
  };
  ```

- **Per command** — `shell: true` forces a single command to run verbatim as a shell command
  (ignoring any global prefix), and `prefix: '...'` overrides the prefix for just that command:

  ```javascript
  {
    phases: [{ name: 'mixed', parallel: [
      { command: 'build' },                          // -> npm run build (global default)
      { command: 'docker compose up -d', shell: true }, // raw shell command
      { command: 'release', prefix: 'yarn' },        // -> yarn release
    ]}],
  }
  ```

Precedence per command: `shell: true` (raw) → per-command `prefix` → global `command_prefix`
→ the built-in `npm run` default. Existing configs are unaffected — omitting all of these keeps
the original `npm run` behaviour.

### Phase Configuration

When using the phases format, each phase can have the following properties:

```javascript
{
  name: 'phase_name',               // The name of the phase
  optional: true,                   // Whether this phase is optional (default: false)
  parallel: [                       // Array of commands to run in parallel
    // ... command configurations
  ]
}
```

## Example Configurations

Here are some practical examples of how to configure the orchestrator for different scenarios:

### Basic Build and Test Pipeline
```javascript
export default [
  {
    command: 'build',
    description: 'Build the project',
    status: 'enabled',
    attempts: 1
  },
  {
    command: 'test',
    description: 'Run unit tests',
    status: 'enabled',
    attempts: 2,
    should_retry: (output) => {
      // Only retry if there are actual test failures
      const testSummaryMatch = output.match(/Test Suites:.*?(\d+) failed/);
      return testSummaryMatch && parseInt(testSummaryMatch[1]) > 0;
    }
  },
  {
    command: 'lint',
    description: 'Run lint checks',
    status: 'enabled'
  }
];
```

### Basic Build and Test Pipeline with Phases
```javascript
export default {
  phases: [
    {
      name: 'build',
      parallel: [
        {
          command: 'build',
          description: 'Build the project',
          status: 'enabled',
          attempts: 1
        }
      ]
    },
    {
      name: 'test',
      parallel: [
        {
          command: 'test',
          description: 'Run unit tests',
          status: 'enabled',
          attempts: 2,
          should_retry: (output) => {
            // Only retry if there are actual test failures
            const testSummaryMatch = output.match(/Test Suites:.*?(\d+) failed/);
            return testSummaryMatch && parseInt(testSummaryMatch[1]) > 0;
          }
        },
        {
          command: 'lint',
          description: 'Run lint checks',
          status: 'enabled'
        }
      ]
    },
    {
      name: 'optional-e2e',
      optional: true,
      parallel: [
        {
          command: 'playwright',
          description: 'Run end-to-end tests',
          status: 'enabled',
          attempts: 1
        }
      ]
    }
  ]
};
```

### Using Environment Variables

You can pass custom environment variables to commands using the `env` property. This is useful for configuring ports, API endpoints, or any environment-specific settings:

```javascript
export default {
  phases: [
    {
      name: 'playwright',
      parallel: [
        {
          command: 'playwright_ci',
          description: 'Run Playwright tests',
          env: {
            PLAYWRIGHT_PORT: 5173,
            API_URL: 'http://localhost:3000',
            TEST_ENV: 'ci'
          },
          status: 'enabled',
          attempts: 1,
          dependencies: [
            {
              command: 'dev',
              background: true,
              env: {
                PORT: 5173
              },
              health_check: {
                url: 'http://localhost:5173',
                max_attempts: 20,
                interval: 2000
              }
            }
          ]
        }
      ]
    }
  ]
};
```

The command will run with the environment variables set, equivalent to:
```bash
PLAYWRIGHT_PORT=5173 API_URL=http://localhost:3000 TEST_ENV=ci npm run playwright_ci
```

See more examples [here](./docs/samples.md)

## Command Types

The orchestrator is completely agnostic to what commands it runs. It can execute any npm scripts. Common use cases include:

1. **Build Processes**: Compile, bundle, or build your project
2. **Testing**: Run unit tests, integration tests, or end-to-end tests
3. **Code Quality**: Run linters, formatters, or static analysis tools
4. **Documentation**: Generate documentation or run documentation tests
5. **Deployment**: Run deployment scripts or environment checks
6. **Custom Scripts**: Execute any custom npm scripts or shell commands

The orchestrator doesn't care what the commands do - it just ensures they run (in parallel), handles dependencies, manages background processes, and provides proper logging and error handling.

## Usage

### Local Installation

1. Create a configuration file (e.g., `scripts-orchestrator.config.js`) in your project root
2. Configure your commands in the config file
3. Add a script to your package.json:
   ```json
   {
     "scripts": {
       "scripts-orchestrator": "npx scripts-orchestrator"
     }
   }
   ```
4. Run the orchestrator:
   ```bash
   # Using default config file (scripts-orchestrator.config.js)
   npm run scripts-orchestrator

   # Or specify a custom config file
   npm run scripts-orchestrator -- ./path/to/your/config.js

   # Start from a specific phase
   npm run scripts-orchestrator -- --phase "unit tests"

   # Start from a specific phase with custom config
   npm run scripts-orchestrator -- ./path/to/your/config.js --phase "playwright"

   # Run specific optional phases
   npm run scripts-orchestrator -- --phases "optional-e2e,optional-performance"

   # Run with verbose logging
   npm run scripts-orchestrator -- --verbose

   # Run in sequential mode (for low CPU machines)
   npm run scripts-orchestrator -- --sequential

   # Specify a custom log folder
   npm run scripts-orchestrator -- --logFolder ./custom-logs

   # Force execution even if git state is unchanged
   npm run scripts-orchestrator -- --force
   ```

### Starting from a Specific Phase

You can start the orchestrator from a specific phase instead of running all phases from the beginning. This is useful for debugging or when you want to skip earlier phases that have already been completed.

#### Method 1: Command Line Argument
```bash
# Start from the "unit tests" phase
npm run scripts-orchestrator -- --phase "unit tests"
```

#### Method 2: Configuration File
```javascript
export default {
  start_phase: "unit tests",  // Start from this phase
  phases: [
    // ... your phases
  ]
};
```

**Note**: Command line arguments take precedence over configuration file settings.

When starting from a specific phase:
- All phases before the specified phase are skipped
- Commands in skipped phases are marked as "skipped" in the final summary
- The orchestrator validates that the specified phase exists and shows available phases if not found

### Optional Phases

You can mark phases as optional by adding `optional: true` to the phase configuration. Optional phases will only run if explicitly requested via the `--phases` command line argument.

#### Configuration
```javascript
export default {
  phases: [
    {
      name: 'build',
      parallel: [
        { command: 'build', description: 'Build the project' }
      ]
    },
    {
      name: 'optional-e2e',
      optional: true,  // This phase is optional
      parallel: [
        { command: 'playwright', description: 'Run end-to-end tests' }
      ]
    },
    {
      name: 'optional-performance',
      optional: true,  // This phase is optional
      parallel: [
        { command: 'lighthouse', description: 'Run performance tests' }
      ]
    }
  ]
};
```

#### Usage
```bash
# Run only the default phases (build, test, etc.)
npm run scripts-orchestrator

# Run specific optional phases
npm run scripts-orchestrator -- --phases "optional-e2e"

# Run multiple optional phases
npm run scripts-orchestrator -- --phases "optional-e2e,optional-performance"

# Run all phases including optional ones
npm run scripts-orchestrator -- --phases "build,test,optional-e2e,optional-performance"
```

**Note**: 
- Optional phases are skipped by default unless explicitly requested
- You can combine `--phase` and `--phases` arguments
- The orchestrator validates that all specified phases exist
- Commands in skipped optional phases are marked as "skipped" in the final summary

### Sequential Mode

By default, the orchestrator runs commands within each phase in parallel for optimal performance. However, you can use the `--sequential` flag to run all commands sequentially, which is useful for low CPU machines or when you need to reduce resource consumption.

#### Usage
```bash
# Run all commands sequentially instead of in parallel
npm run scripts-orchestrator -- --sequential
```

When running in sequential mode:
- Commands within each phase are executed one at a time
- Phases still run sequentially (as they always do)
- If a command fails, the remaining commands in that phase are skipped
- Lower CPU and memory usage compared to parallel execution
- Longer total execution time

This is particularly useful for:
- CI/CD environments with limited resources
- Development machines with low CPU/memory
- Debugging individual command failures
- Avoiding resource contention between commands

### Limiting Concurrency (`max_concurrency`)

Sequential mode is all-or-nothing. When a phase declares many parallel commands, running *every* one at once can overwhelm a smaller machine (each command may spin up its own Node/toolchain), while `--sequential` over-corrects by dropping to one at a time. `max_concurrency` is the middle ground: it caps how many of a phase's commands run **at once** without serialising everything.

- **`'auto'` (the default)** resolves to `max(1, cpuCount - 1)`, leaving one core for the OS/editor.
- **A positive integer** pins the cap to that exact number.
- **`0`, negative, or unparseable** values fall back to `auto`.

When the cap is greater than or equal to a phase's command count, behaviour is identical to unbounded parallel execution — so well-provisioned machines see no change. As each command finishes, the next queued one starts, keeping at most `max_concurrency` in flight. `--sequential` still wins (it is equivalent to a cap of 1).

#### Configuration

```js
export default {
  max_concurrency: 'auto', // or a number like 4
  phases: [
    {
      name: 'quality checks',
      parallel: [
        { command: 'lint' },
        { command: 'typecheck' },
        { command: 'test' },
        // ...more commands than the machine can run at once
      ],
    },
  ],
};
```

#### CLI override

The `--max-concurrency` flag overrides the configured value for a single run:

```bash
# Run at most 3 commands per phase concurrently
npm run scripts-orchestrator -- --max-concurrency 3

# Force the auto cap (CPU count - 1) regardless of config
npm run scripts-orchestrator -- --max-concurrency auto
```

At the start of a parallel run the orchestrator logs the resolved cap, e.g. `🧮 Max concurrency: 3 (of 8 CPUs)`.

#### Per-phase override

A single phase can pin its own cap by setting `max_concurrency` on the phase itself. This is the right tool when one phase's commands share a single resource — a dev server, a GPU, a port — and must run one at a time, while every other phase keeps the global cap and its parallelism. The phase value resolves the same way as the global one (`'auto'` and invalid values fall back to CPU count − 1), and overrides both the configured global cap and any `--max-concurrency` flag for that phase only.

```js
export default {
  max_concurrency: 'auto', // global default for every phase
  phases: [
    { name: 'quality checks', parallel: [/* runs at the global cap */] },
    {
      name: 'browser suites',
      max_concurrency: 1, // serialise just this phase (one shared dev server)
      parallel: [
        { command: 'e2e:group-a' },
        { command: 'e2e:group-b' },
        // ...each runs in turn; a failed group does NOT abort the others
      ],
    },
  ],
};
```

A serial phase (`max_concurrency: 1`) still runs through the parallel path, so it **continues past a failed command** rather than stopping on the first failure — unlike the global `--sequential` flag, which both serialises everything and stops the phase at its first failure. When a phase's cap differs from the global one the orchestrator logs the override, e.g. `↳ phase concurrency: 1 (phase "browser suites" overrides the 3 default)`.

## Error Handling

- The script tracks failed and skipped commands
- Provides detailed error messages and logs
- Handles process cleanup on script termination
- Manages background processes and ensures proper cleanup

## Logging

- Each command's output is logged to `scripts-orchestrator-logs/<command>.log` in the current working directory
- Main orchestrator logs are saved to `scripts-orchestrator-logs/orchestrator-main-<timestamp>.log`
- Git commit hash is cached in `scripts-orchestrator-logs/.git-hash-cache` for skip detection
- Provides real-time status updates during execution
- Summarizes results at the end of execution

### Custom Log Folder

You can customize the log folder location using either the command line or configuration file:

#### Method 1: Command Line Argument
```bash
# Use a custom log folder
npm run scripts-orchestrator -- --logFolder ./my-custom-logs
```

#### Method 2: Configuration File
```javascript
export default {
  log_folder: './my-custom-logs',  // Custom log folder
  phases: [
    // ... your phases
  ]
};
```

**Note**: Command line arguments take precedence over configuration file settings.

All logs (command logs, main orchestrator logs, and git cache) will be stored in the specified folder.

## Live Dashboard Integration (v2.14+)

### Incremental JSON results

By default `json_results` is written only at the end of a run. From v2.14 onward the file is
updated atomically (write-to-temp + rename) after **each command starts or completes**, so
watchers always see a consistent snapshot:

```json
{
  "success": null,
  "timestamp": "2026-06-04T07:13:21.000Z",
  "commands": [
    { "command": "lint-ci", "phase": "lint", "success": true, "durationMs": 4200 },
    { "command": "playwright_ci", "phase": "tests", "success": null, "startedAt": "2026-06-04T07:13:25.000Z" }
  ]
}
```

`"success": null` at the top level is the in-progress sentinel. It is replaced with `true` or
`false` when `writeJsonResults` writes the final result.

### NDJSON event stream

Alongside `json_results`, the library writes one NDJSON line per event to
`<json_results_basename>-events.ndjson`:

```jsonl
{"type":"command_start","timestamp":"...","command":"lint-ci","phase":"lint","scope":"workspace"}
{"type":"command_end","timestamp":"...","command":"lint-ci","phase":"lint","success":true,"durationMs":4200}
{"type":"run_end","timestamp":"...","success":true,"durationMs":12800}
```

Dashboard tools can `tail -f` this file or watch it with `fs.watch` to get real-time updates
without parsing human-readable log lines.

### Run-state file

When `--logFolder` is specified, the library writes `{logFolder}/.scripts-orchestrator-run.json`
at run start and removes it on run end:

```json
{
  "startedAt": "2026-06-04T07:13:17.000Z",
  "pid": 12345,
  "phase": "tests",
  "activeCommand": "playwright_ci"
}
```

This file is the authoritative in-progress signal for live dashboards. Its absence means the run
has finished (or never started).

### Post-run hook

Add `post_run` to your config to run a shell command **after** `json_results` is written and the
run-state file is cleared, but **before** `process.exit()`:

```javascript
export default {
  json_results: './logs/scripts-orchestrator-results.json',
  post_run: 'node scripts/generate-report.js',  // called after every run
  phases: [ /* ... */ ]
};
```

The hook receives two environment variables:
- `SCRIPTS_ORCHESTRATOR_SUCCESS=1` (or `0`) — whether the run succeeded
- `SCRIPTS_ORCHESTRATOR_EXIT_CODE=0` (or `1`) — same, as a numeric exit code

The hook runs synchronously and its exit code is logged but does not change the orchestrator's
own exit code.

**Typical use case:** roll up a monorepo report after each workspace finishes (see
**npm workspace aggregation** below):
```javascript
post_run: 'npx scripts-orchestrator --aggregate ../../scripts-orchestrator-aggregate.config.js'
```

## npm workspace aggregation (v3.1+)

In a monorepo, each npm workspace can run its own orchestrator gate (writing its own
`json_results`), and a root run can run repo-wide "global" checks. The aggregator rolls all of
these into one report — no per-repo merge script required. Drive it the easy way with the
declarative [`aggregate` config key](#declarative-aggregate-config-key-recommended-v32) below, or
invoke the [`--aggregate` CLI mode](#--aggregate-cli-mode) directly.

It reads only artifacts the library itself writes — each scope's `json_results` and the
**run-state file** (`.scripts-orchestrator-run.json`) — so it needs no log scraping. The
run-state file tells it whether the run is still in flight (live report with auto-refresh) or
finished (static report). Each workspace section is classified as **OK / FAIL / RUNNING /
PENDING / STALE / INTERRUPTED / N/A** from its own results JSON and the run window.

### Declarative `aggregate` config key (recommended, v3.2+)

Rather than wiring a `periodic_hook` / `post_run` that shells out to `--aggregate`, set the
**`aggregate`** key in your orchestrator config and the library drives the roll-up **in-process** —
no subprocess spawned every interval, no dependency on `npx`/PATH resolution:

```javascript
// root run config — roll up periodically while running + once, static, at the end
aggregate: './scripts-orchestrator-aggregate.config.js',  // or `true` for the built-in defaults
periodic_interval_ms: 45000,                              // cadence for the in-process roll-up

// each workspace gate config — refresh the roll-up as that workspace finishes
aggregate: '../../scripts-orchestrator-aggregate.config.js',
```

The value may be `true` (use defaults), a path to a config module (its `default` export is used as
the options below), or an options object inline. The library auto-detects whether the current run is
the **repo-root run** (it owns the periodic cadence and writes the final static report) or a
**fanned-out workspace run** (it refreshes the roll-up once, as that workspace finishes, leaving the
report in-progress because the root run is still live). On interrupt, the orchestrator writes one
final static roll-up itself.

### `--aggregate` CLI mode

The same roll-up is available as a standalone CLI mode (used internally by the declarative key, and
handy for manual/one-off rendering or legacy hook wiring). It is safe to fire repeatedly:

```bash
scripts-orchestrator --aggregate                                   # use the built-in defaults
scripts-orchestrator --aggregate ./scripts-orchestrator-aggregate.config.js   # override paths/title
```

The optional config module's `default` export may override any of these (all paths are
resolved against the auto-detected repo root unless absolute):

| Key | Default | Meaning |
| --- | --- | --- |
| `title` | `Workspaces Quality Report` | Report heading |
| `outJson` / `outHtml` | `logs/monorepo-quality-report.{json,html}` | Where the roll-up is written |
| `runStateFile` | `logs/.scripts-orchestrator-run.json` | Run-state file used to detect in-progress + run start |
| `rootResults` | `logs/scripts-orchestrator-logs/scripts-orchestrator-results.json` | Root run's results (source of global-check rows) |
| `globalResults` | `logs/scripts-orchestrator-logs/scripts-orchestrator-global-results.json` | Fallback source of global-check rows |
| `workspaceResults` | `logs/scripts-orchestrator-logs/scripts-orchestrator-results.json` | Per-workspace results path (relative to each workspace) |
| `globalPhase` / `workspacePhase` | `global quality checks` / `workspace quality gates` | Phase names used to split global rows from the fan-out row |
| `refreshSecs` | `5` | Auto-refresh cadence injected while the run is in progress |
| `exclude` | `[]` | Workspace directories (repo-root-relative) to omit |

The library also exports the building blocks for programmatic use:
`findRepoRoot`, `discoverWorkspaceDirs`, `aggregateWorkspacesReport`, `writeAggregateReport`.

## Git-Based Caching

The orchestrator automatically tracks the git commit hash and repository state to optimize execution:

- **On first run**: Records the current git commit hash in `scripts-orchestrator-logs/.git-hash-cache`
- **On subsequent runs**: Checks if:
  - The git commit hash matches the cached hash
  - There are no staged or unstaged changes in the repository
- **When conditions are met**: Skips execution entirely with message `✓ Git state unchanged`
- **When conditions fail**: Runs normally and updates the cache on successful completion

This feature is particularly useful in CI/CD pipelines where the same commit might be processed multiple times, saving time and resources by avoiding redundant executions.

**Note**: The cache is only updated on successful execution. Failed runs will not update the cache, ensuring subsequent runs will retry.

### Force Execution

You can bypass the git cache check and force execution even when the git state is unchanged by using the `--force` flag:

```bash
# Force execution regardless of git state
npm run scripts-orchestrator -- --force
```

This is useful when you want to:
- Re-run commands without making code changes
- Test configuration changes
- Debug issues without modifying the codebase
- Override the cache in CI/CD pipelines

## Phase Recommendations (advisory)

When a run is executed with `metrics: ['time', 'memory']`, the results JSON records each command's
`durationMs` and peak `memoryKb`. Add `'cpu'` (`metrics: ['time', 'memory', 'cpu']`) to also record
`cpuPercent` — average CPU utilisation over the command's wall-clock, where `100` means one core fully
busy for the whole run and `>100` means multiple cores on average (derived from the same `/usr/bin/time`
measurement as memory, Linux/macOS only, no extra process spawned). The `--recommend` mode reads that
JSON and reports a **resource-aware phase recommendation**: it packs phases under both a memory budget
and the host's CPU core share. It never runs anything and changes no run state.

It accepts either a single-scope results JSON or a whole-monorepo **roll-up report** (the kind written
by [`--aggregate`](#npm-workspace-aggregation-v31) / the `aggregate` config key, default
`logs/monorepo-quality-report.json`). Given a roll-up it pools every scope's (each npm workspace's, plus
the global checks') timed commands and produces a single cross-scope recommendation, as if the whole
monorepo ran on one host. Each step keeps its scope in its phase and command label
(e.g. `@app/web › build` / `@app/web: build`) so the observed timeline stays per-scope while packing
re-groups freely across scopes; empty/pending sections are skipped and partial/in-progress roll-ups are
flagged.

```bash
# Analyse an existing results JSON and print a suggested phase layout to the console
scripts-orchestrator --recommend ./logs/scripts-orchestrator-results.json

# Analyse a whole-monorepo roll-up report for one cross-scope recommendation
scripts-orchestrator --recommend ./logs/monorepo-quality-report.json

# Write the report to a plain-text log file instead of the console (only a pointer line is printed)
scripts-orchestrator --recommend ./logs/results.json --recommend-out ./logs/recommendation.log

# Size the budget for a machine running N gates in parallel (each gets 1/N of RAM and cores)
scripts-orchestrator --recommend ./logs/scripts-orchestrator-results.json --fanout 3

# Override the memory budget explicitly (MB) or change the RAM safety fraction
scripts-orchestrator --recommend ./logs/results.json --budget-mb 8192
scripts-orchestrator --recommend ./logs/results.json --mem-safety 0.7
```

It reports three things:

1. **Observed timeline** — each phase's wall-clock (the longest step in it), the concurrent peak
   memory (Σ of member peaks) and the concurrent CPU demand (Σ of member core-equivalents), flagging
   any phase whose concurrent peak exceeds the host memory budget or core share.
2. **Recommended layout** — a [First-Fit-Decreasing](https://en.wikipedia.org/wiki/Bin_packing_problem)
   bin-packing by duration that groups steps into sequential phases so each phase's concurrent peak
   memory stays under `budget = totalmem × memSafety ÷ fanout` and its concurrent CPU demand stays under
   `coreShare = (cores − 2) ÷ fanout`. Each step's CPU demand is its measured `cpuPercent ÷ 100`
   core-equivalents; when the `cpu` metric isn't collected every step counts as one core, so the
   core-share constraint degrades to a simple "≤ coreShare steps per phase" limit. With real CPU data,
   I/O-bound steps (well under one core) pack denser while genuinely parallel steps can't be stacked into
   oversubscription. Long steps seed phases; short steps fill the gaps beneath them, so the estimated
   makespan stays near the theoretical floor (the single longest step) without oversubscribing RAM or CPU.
3. **Verdict** — a single yes/no line: whether re-grouping is worth it (it must trim ≥5% and ≥5s off
   the makespan), or — when one step is ≥95% of the makespan — that the only remaining lever is to
   split that step into smaller commands the orchestrator can schedule separately.

The same logic is exported for programmatic use:

```js
import { recommendPhases, formatRecommendationReport } from 'scripts-orchestrator';

const payload = JSON.parse(fs.readFileSync('./logs/results.json', 'utf8'));
const rec = recommendPhases(payload, { fanout: 3 });
console.log(formatRecommendationReport(rec));
// rec.verdict.worthwhile, rec.verdict.reason, rec.recommended.bins, rec.observed, rec.budgetBytes, …
```

A natural place to wire it is the `post_run` config hook, so each run prints a recommendation for its
own results JSON when it finishes.

This is advisory only — the budget is conservative (per-process peaks summed as if they coincide) and
the packing does not model inter-phase data dependencies, so validate any suggested layout against a
real run before adopting it.

## Exit Codes

- `0`: All commands executed successfully
- `1`: One or more commands failed or were skipped


## History
See [versions](./docs/versions.md)

## Roadmap
- Better UX to indicate what is happening
- Tests to avoid regression
- Run any shell command rather than assume the command is specified in package.json (? tentative)
- Promote the advisory `--recommend` phase recommender into an opt-in automatic scheduler that packs each phase under a per-host memory budget and CPU core share at run time


## Disclaimer

This software is provided "as is", without warranty of any kind, express or implied. The author(s) shall not be liable for any claims, damages, or other liabilities arising from the use of this software. Users are responsible for testing and verifying the software in their own environment before using it in production.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


