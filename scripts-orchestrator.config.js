export default {
  phases: [
    {
      name: 'build',
      parallel: [
        {
          command: 'build',
          description: 'Build the project',
          status: 'enabled',
          attempts: 1,
        },
        {
          command: 'stylelint',
          description: 'Run stylelint checks',
          status: 'enabled',
        },
        { command: 'lint', description: 'Run lint checks', status: 'enabled' },
        {
          command: 'jscpd',
          description: 'Run code duplication checks',
          status: 'enabled',
        },
      ],
    },
    {
      name: 'storybook tests',
      parallel: [
        {
          command: 'test-storybook',
          description: 'Run Storybook tests',
          status: 'enabled',
          attempts: 2,
          dependencies: [
            {
              command: 'storybook_silent',
              background: true,
              wait: 5000,
              kill_command: 'kill_storybook',
              dependencies: [],
              // Add process tracking
              process_tracking: true,
              // Add health check
              health_check: {
                url: 'http://localhost:6006',
                max_attempts: 20,
                interval: 2000,
              },
            },
          ],
        },
      ],
    },
    {
      name: 'unit tests',
      parallel: [
        {
          command: 'test-ci',
          description: 'Run unit tests',
          status: 'enabled',
          attempts: 2,
          should_retry: (output) => {
            // Check for test failures in both formats
            const testSuiteFailureMatch = output.match(
              /Test Suites:.*?\(\d+\) failed/,
            );
            const individualTestFailureMatch =
              output.match(/✘\s*(\d+)\s*failing/);

            const hasTestSuiteFailures =
              testSuiteFailureMatch && parseInt(testSuiteFailureMatch[1]) > 0;
            const hasIndividualTestFailures =
              individualTestFailureMatch &&
              parseInt(individualTestFailureMatch[1]) > 0;

            const hasTestFailures =
              hasTestSuiteFailures || hasIndividualTestFailures;

            // Check for "Test suite failed to run" in logs
            if (output.includes('Test suite failed to run')) {
              console.error('Certain tests could not be run');
              return false; // Don't retry if certain tests could not be run
            }

            if (!hasTestFailures) {
              console.log(
                'Tests have passed but coverage thresholds have not been met',
              );
              return false; // Don't retry if only coverage failed
            }

            return hasTestFailures; // Only retry if there are actual test failures
          },
        },
      ],
    },
    {
      name: 'playwright',
      parallel: [
        {
          command: 'playwright_ci',
          description: 'Run Playwright tests',
          status: 'enabled',
          attempts: 1, //Playwright internally retries in CI mode
          dependencies: [
            {
              command: 'dev',
              background: true,
              url: 'http://localhost:5173',
            },
          ],
        },
      ],
    },
  ],
};
