## Using as a Linked Package (Development/Monorepo)

If you want to use this orchestrator directly in another repository (for local development or monorepo setups), you can use `npm link`:

1. In the scripts-orchestrator project root, run:
   ```bash
   npm link
   ```
   This makes the orchestrator available globally on your system as a symlinked package.

2. In your target project (the repo where you want to use the orchestrator), run:
   ```bash
   npm link scripts-orchestrator
   ```
   This links the orchestrator package into your project's `node_modules`.

3. You can now use it in your target project as described above (add to your `package.json` scripts, create a config, etc.).

4. To unlink later, run:
   ```bash
   npm unlink scripts-orchestrator
   ```
   in your target project, and optionally
   ```bash
   npm unlink --global scripts-orchestrator
   ```
   in the orchestrator repo.
