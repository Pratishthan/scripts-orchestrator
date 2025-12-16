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

## Configuration

Create a configuration file (default: `scripts-orchestrator.config.js`) that defines an array of commands to execute. Each command can have the following properties:

```javascript
{
  command: 'command_name',           // The npm script to run
  description: 'Description',        // Optional description
  status: 'enabled',                 // 'enabled' or 'disabled'
  attempts: 1,                       // Number of retry attempts
  dependencies: [],                 // Array of dependent commands
  background: false,                // Whether to run in background
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

## Exit Codes

- `0`: All commands executed successfully
- `1`: One or more commands failed or were skipped


## History
See [versions](./docs/versions.md)

## Roadmap
- Better UX to indicate what is happening
- Tests to avoid regression
- Run any shell command rather than assume the command is specified in package.json (? tentative)


## Disclaimer

This software is provided "as is", without warranty of any kind, express or implied. The author(s) shall not be liable for any claims, damages, or other liabilities arising from the use of this software. Users are responsible for testing and verifying the software in their own environment before using it in production.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


