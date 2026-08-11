/**
 * Invariant 6: a built-in transport may import only node builtins or a declared
 * dependency of `packages/dead-drop`.
 *
 * Workspaces are hoisted in this repository, so a transport importing a package
 * that nothing declares resolves perfectly here and is simply absent from a real
 * `npm install`. The failure lands on a user as a module-not-found at the moment
 * they configure that transport, which is the worst possible place for it.
 *
 * A test named in AGENTS.md used to enforce this from `packages/cli`. It did not
 * survive the consolidation into two packages, and the invariant went unguarded
 * for several releases; it held only because no transport happened to gain an
 * import in that window. This is that guard, written against the rule rather
 * than against the old package layout.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const manifest = require('../packages/dead-drop/package.json') as {
  dependencies?: Record<string, string>;
};
const transportsDir = fileURLToPath(
  new URL('../packages/dead-drop/src/transports', import.meta.url),
);

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Static `import`/`export ... from` and dynamic `import()` specifiers. A regex
 * rather than a parse because the alternative is a TypeScript dependency in the
 * test tree to answer a question about strings.
 */
function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) found.add(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    found.add(match[1]!);
  return [...found];
}

/** `@scope/name/subpath` and `name/subpath` both resolve from the same package. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

describe('built-in transport imports', () => {
  it('names only node builtins or a declared dependency of packages/dead-drop', async () => {
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const builtins = new Set(builtinModules);
    const files = await sourceFiles(transportsDir);
    // A transport tree that reads as empty would make every assertion below pass
    // without checking anything.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiers(await readFile(file, 'utf8'))) {
        if (specifier.startsWith('.') || specifier.startsWith('#')) continue;
        if (specifier.startsWith('node:')) continue;
        const name = packageName(specifier);
        if (builtins.has(name) || declared.has(name)) continue;
        offenders.push(`${file.slice(transportsDir.length + 1)} imports ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
