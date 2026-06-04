### 1.0.0
Works!

### 2.0.0
* Added 'phases' so that some sequencing can be added if necessary
* Noticed that running `jest` & `storybook` together was causing some corruption. Added process isolation. 

### 2.1.0
* Added support for kill_command
* Improved method signatures (single parameter)
* Retried commands now append to the original log file rather than truncating them first

### 2.2.0
* Dependencies are immediatley terminated rather than waiting for the cleanup

### 2.3.0
* Windows functionality had got broken - I was using unix-specific commands

### 2.4.0
* Fix logic to fail catastrophically if sub-commands fail. 


#### 2.4.2
* Fix some Promise.all instances to be Promise.allSettled
* Fix order of code which could be causing the process to hang

### 2.5.0
* Added support for starting from a specific phase
* New command line argument `--phase <phase-name>` to specify starting phase
* New configuration option `start_phase` to set default starting phase
* Command line arguments take precedence over configuration file settings
* Improved error handling with validation of specified start phase
* Commands in skipped phases are properly marked in the final summary

### 2.6.0
* Added support for configurable log folder location
* New command line argument `--logFolder <directory>` to specify parent directory for logs
* New configuration option `log_folder` to set default log folder parent directory
* The `scripts-orchestrator-logs` folder will be created inside the specified directory
* Cross-platform compatibility for Windows, macOS, and Linux
* Automatic directory creation with recursive path support
* Command line arguments take precedence over configuration file settings

#### 2.7.0
* Improved handling of log file name.
* Added support for optional phases

#### 2.7.1
* Added support for `env`

### 2.8.0
* Added git-based caching to skip execution when repository state is unchanged
* Orchestrator now checks git commit hash and repository status before running
* Cache file `.git-hash-cache` is stored in the log folder
* Execution is skipped when:
  - Git commit hash matches cached hash
  - No staged or unstaged changes are present
* Cache is only updated on successful execution
* Improves efficiency in CI/CD pipelines by avoiding redundant runs

### 2.10.0
* Added `--force` flag to bypass git cache check and force execution
* New command line argument `--force` to execute regardless of git state
* Useful for re-running commands without code changes or testing configuration
* Log message now indicates how to force execution when skipping

### 2.11.0
* Added `json_results` config option to write command results as JSON
* Added `html_results` config option to write an HTML report
* Added `metrics` config option (`time`, `memory`) for per-command timing and memory tracking

### 2.12.0
* Added support for `retry_command` to run a different command on retry
* Added `process_tracking` for better background process lifecycle management
* Phase results (`phases[]`) included in JSON output when using phased config

### 2.13.0
* Added `--metrics` CLI flag (overrides config `metrics`)
* Added `--json-results` and `--html-results` CLI flags
* Background process cleanup improvements

### 2.14.0
* **Incremental JSON results (A1)**: `json_results` is now written atomically after every command
  start and completion. `"success": null` at the top level is the in-progress sentinel; replaced
  with `true`/`false` when the run finishes. In-flight commands include `startedAt` timestamp.
* **NDJSON event stream (A2)**: A `<json_results_basename>-events.ndjson` file is written
  alongside `json_results`, with one line per `command_start`, `command_end`, and `run_end` event.
  Enables real-time dashboard integration without parsing human log lines.
* **Run-state file (A4)**: When `--logFolder` is set, the library writes
  `{logFolder}/.scripts-orchestrator-run.json` at run start (with `startedAt`, `pid`,
  `activeCommand`, `phase`) and deletes it on run end. Live dashboards watch this file as the
  authoritative in-progress signal.
* **Post-run hook (A7)**: New `post_run` config option — a shell command run synchronously after
  `json_results` is written and the run-state file is cleared. Receives
  `SCRIPTS_ORCHESTRATOR_SUCCESS` and `SCRIPTS_ORCHESTRATOR_EXIT_CODE` env vars.
