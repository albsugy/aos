#!/usr/bin/env node
// Source entry point (dev / npm installs). Compiled installs run dist/aos.mjs,
// built from src/cli.js by scripts/build.mjs. cli.js only auto-runs when it is
// itself the process entry (the bundle case); here it is imported, so we invoke
// main() explicitly.
import { main } from '../src/cli.js';
main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
