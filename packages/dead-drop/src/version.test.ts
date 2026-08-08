import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { VERSION } from './version.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('VERSION', () => {
  it('matches the package manifest', () => {
    const manifest = createRequire(import.meta.url)('../package.json') as { version: string };
    expect(VERSION).toBe(manifest.version);
  });

  it('is the only place a version is defined', () => {
    // The bug this guards: `cli.ts`, `runtime.ts` and `workspace.ts` each had
    // their own `'0.1.0'` literal, and the 0.2.0 release updated none of them.
    // The published CLI reported 0.1.0 from `--version`, and the same value
    // reached `ddrop status` and `/health`. Asserting the output equals the
    // constant that produced it cannot catch that; this can.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('version.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const [line] of text.matchAll(/^.*version\s*(\?\?|=|:)\s*['"]\d+\.\d+\.\d+['"].*$/gim)) {
        offenders.push(`${file.slice(SRC.length)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
