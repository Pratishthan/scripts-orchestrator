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
- **Dependency Management**: Handles command dependencies and ensures proper execution order
- **Background Processes**: Supports running commands in the background with health checks
- **Retry Mechanism**: Configurable retry attempts for failed commands
- **Process Management**: Proper cleanup of background processes
- **Health Checks**: Verifies service availability before proceeding
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
    }
  ]
};
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
   ```

## Error Handling

- The script tracks failed and skipped commands
- Provides detailed error messages and logs
- Handles process cleanup on script termination
- Manages background processes and ensures proper cleanup

## Logging

- Each command's output is logged to `scripts-orchestrator-logs/<command>.log` in the current working directory
- Provides real-time status updates during execution
- Summarizes results at the end of execution

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


