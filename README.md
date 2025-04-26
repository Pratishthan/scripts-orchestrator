# Scripts Orchestrator

A powerful script orchestrator for running parallel commands with dependency management, background processes, and health checks. Perfect for CI/CD pipelines and automated testing workflows.

## Installation

```bash
# Install as a development dependency
npm install --save-dev scripts-orchestrator

# Or install globally
npm install -g scripts-orchestrator
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
  command: 'command_name',        // The npm script to run
  description: 'Description',     // Optional description
  status: 'enabled',             // 'enabled' or 'disabled'
  attempts: 1,                   // Number of retry attempts
  dependencies: [],              // Array of dependent commands
  background: false,             // Whether to run in background
  health_check: {                // Health check configuration
    url: 'http://localhost:port',
    max_attempts: 20,
    interval: 2000
  },
  should_retry: (output) => {    // Custom retry logic
    // Return true to retry, false to skip
  }
}
```

## Command Types

The orchestrator is completely agnostic to what commands it runs. It can execute any npm scripts or shell commands. Common use cases include:

1. **Build Processes**: Compile, bundle, or build your project
2. **Testing**: Run unit tests, integration tests, or end-to-end tests
3. **Code Quality**: Run linters, formatters, or static analysis tools
4. **Documentation**: Generate documentation or run documentation tests
5. **Deployment**: Run deployment scripts or environment checks
6. **Custom Scripts**: Execute any custom npm scripts or shell commands

The orchestrator doesn't care what the commands do - it just ensures they run in the correct order, handles dependencies, manages background processes, and provides proper logging and error handling.

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

### Global Installation

1. Create a configuration file in your project root
2. Configure your commands in the config file
3. Run the orchestrator:
   ```bash
   # Using default config file (scripts-orchestrator.config.js)
   scripts-orchestrator

   # Or specify a custom config file
   scripts-orchestrator ./path/to/your/config.js
   ```

## Error Handling

- The script tracks failed and skipped commands
- Provides detailed error messages and logs
- Handles process cleanup on script termination
- Manages background processes and ensures proper cleanup

## Logging

- Each command's output is logged to `logs/scripts-orchestrator_<command>.log`
- Provides real-time status updates during execution
- Summarizes results at the end of execution

## Exit Codes

- `0`: All commands executed successfully
- `1`: One or more commands failed or were skipped

## Signal Handling

The script properly handles various termination signals:
- SIGINT (Ctrl+C)
- SIGTERM
- SIGQUIT
- SIGHUP
- Uncaught exceptions
- Unhandled rejections

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © Vivek Kodira 