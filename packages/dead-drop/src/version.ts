/**
 * The package version, read from the manifest.
 *
 * Single source of truth on purpose. This used to be a literal repeated in
 * `cli/cli.ts`, `runtime/runtime.ts` and `runtime/workspace.ts`, and the 0.2.0
 * release updated none of them: the published CLI reported `0.1.0` from
 * `--version`, and the same value reached `ddrop status` and `/health`. Any
 * literal here goes stale the moment someone bumps `package.json`.
 *
 * `../package.json` resolves to the manifest from both `src/` and the built
 * `dist/`, which sit at the same depth. It is exposed as a subpath export, so
 * it stays readable in a published install.
 *
 * This module deliberately sits outside the layer hierarchy: protocol, core,
 * runtime, sdk and cli may all import it.
 */

import { createRequire } from 'node:module';

export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
