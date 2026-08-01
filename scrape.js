#!/usr/bin/env node
import { main } from './src/scrape.js';

main().catch((err) => {
  // A bad command line is the operator's typo, not a crash: print the message
  // on its own so the fix is the first thing on screen, not the last.
  console.error(err?.usage ? err.message : err?.stack || String(err));
  process.exitCode = 1;
});
