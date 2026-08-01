#!/usr/bin/env node
/**
 * Publish guard. Compares the previously committed filler.json against the
 * freshly scraped one and exits non-zero if the data shrank sharply.
 *
 * A partial crawl (mass fetch failures, a site layout change that breaks the
 * selectors) would otherwise be committed as a silent data regression, and the
 * consuming app would quietly stop labelling filler for hundreds of shows.
 *
 * Usage: node scripts/check-regression.js <before.json> <after.json>
 */

import { readFileSync } from 'node:fs';

/** Fraction of the previous entry count that must survive. */
const MIN_RETAINED = 0.9;

const load = (file) => {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error('usage: check-regression.js <before.json> <after.json>');
  process.exit(2);
}

const before = load(beforeFile);
const after = load(afterFile);
const beforeCount = Object.keys(before).length;
const afterCount = Object.keys(after).length;

console.log(`filler.json entries: ${beforeCount} -> ${afterCount}`);

if (afterCount === 0 && beforeCount > 0) {
  console.error('::error::New filler.json is empty; refusing to publish.');
  process.exit(1);
}

if (beforeCount > 0 && afterCount < Math.floor(beforeCount * MIN_RETAINED)) {
  const dropped = Object.keys(before).filter((id) => !(id in after));
  console.error(
    `::error::Entry count fell from ${beforeCount} to ${afterCount} ` +
      `(below the ${MIN_RETAINED * 100}% floor); refusing to publish a truncated run.`,
  );
  console.error(`Dropped ids: ${dropped.slice(0, 40).join(', ')}${dropped.length > 40 ? ', ...' : ''}`);
  process.exit(1);
}

// Also surface large per-show changes; not fatal, just worth seeing in the log.
for (const [id, episodes] of Object.entries(after)) {
  const previous = before[id];
  if (!Array.isArray(previous)) continue;
  const delta = episodes.length - previous.length;
  if (Math.abs(delta) >= 10) {
    console.log(`  note: id ${id} filler count ${previous.length} -> ${episodes.length} (${delta > 0 ? '+' : ''}${delta})`);
  }
}

console.log('Regression guard passed.');
