### Basic Build and Test Pipeline
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

### Storybook Testing with Background Process
```javascript
export default {
  phases: [
    {
      name: 'storybook-tests',
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
              health_check: {
                url: 'http://localhost:6006',
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

### Playwright Testing with Development Server
```javascript
export default {
  phases: [
    {
      name: 'e2e-tests',
      parallel: [
        {
          command: 'playwright_ci',
          description: 'Run Playwright tests',
          status: 'enabled',
          attempts: 1,
          dependencies: [
            {
              command: 'dev',
              background: true,
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

### Full CI Pipeline with Multiple Checks
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
      name: 'static-analysis',
      parallel: [
        {
          command: 'test-ci',
          description: 'Run unit tests',
          status: 'enabled',
          attempts: 2,
          should_retry: (output) => {
            const testSummaryMatch = output.match(/Test Suites:.*?(\d+) failed/);
            const hasTestFailures = testSummaryMatch && parseInt(testSummaryMatch[1]) > 0;
            const hasCoverageFailures = output.match(/Jest: "global" coverage threshold/);
            
            // Only retry for actual test failures, not coverage issues
            return hasTestFailures;
          }
        },
        {
          command: 'stylelint',
          description: 'Run stylelint checks',
          status: 'enabled'
        },
        {
          command: 'lint',
          description: 'Run lint checks',
          status: 'enabled'
        },
        {
          command: 'jscpd',
          description: 'Run code duplication checks',
          status: 'enabled'
        }
      ]
    },
    {
      name: 'integration-tests',
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
              health_check: {
                url: 'http://localhost:6006',
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