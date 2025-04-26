export default [
  {
    command: 'build',
    description: 'Build the project',
    status: 'enabled',
    attempts: 1,
  },
  {
    command: 'test-ci',
    description: 'Run unit tests',
    status: 'enabled',
    attempts: 2,
    should_retry: (output) => {
      // Check for actual test failures in the summary
      const testSummaryMatch = output.match(/Test Suites:.*?(\d+) failed/);
      const hasTestFailures =
        testSummaryMatch && parseInt(testSummaryMatch[1]) > 0;

      // Check for coverage failures
      const coverageSummaryMatch = output.match(
        /Jest: "global" coverage threshold/,
      );
      const hasCoverageFailures = coverageSummaryMatch !== null;

      if (!hasTestFailures && hasCoverageFailures) {
        console.log(
          'Tests have passed but coverage thresholds have not been met',
        );
        return false; // Don't retry if only coverage failed
      }

      return hasTestFailures; // Only retry if there are actual test failures
    },
  },
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
        kill_script: 'kill_storybook',
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
        kill: 'application_end',
      },
    ],
  },
];
