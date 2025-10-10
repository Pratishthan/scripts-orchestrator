export default {
  phases: [
    {
      name: 'build',
      parallel: [
        {
          command: 'echo "Building project..." && exit 0',
          description: 'Build the project',
          status: 'enabled',
          attempts: 1,
        },
      ],
    },
    {
      name: 'test',
      parallel: [
        {
          command: 'echo "Running tests..." && exit 0',
          description: 'Run unit tests',
          status: 'enabled',
          attempts: 1,
        },
      ],
    },
    {
      name: 'optional-e2e',
      optional: true,
      parallel: [
        {
          command: 'echo "Running E2E tests..." && exit 0',
          description: 'Run end-to-end tests',
          status: 'enabled',
          attempts: 1,
        },
      ],
    },
    {
      name: 'optional-performance',
      optional: true,
      parallel: [
        {
          command: 'echo "Running performance tests..." && exit 0',
          description: 'Run performance tests',
          status: 'enabled',
          attempts: 1,
        },
      ],
    },
  ],
}; 