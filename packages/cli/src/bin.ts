#!/usr/bin/env node
/** Entry point for the `bridge` binary. Keeps `cli.ts` importable by tests. */

import { run } from './cli.js';

const code = await run(process.argv.slice(2));
process.exitCode = code;
