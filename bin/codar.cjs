#!/usr/bin/env node
// codar-bot CLI entry — ESM bridge (.cjs wrapper around the ESM dist/).
// This file is CommonJS so that `#!/usr/bin/env node` works without
// package.json "type" assumptions in the global install context.
(async () => {
  await import('../dist/host/cli.js');
})().catch((err) => {
  console.error('codar: failed to start:', err);
  process.exit(1);
});
