import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFileInfo } from 'prettier';
import { ciChanges } from './ciChanges.ts';
import { sourceNames } from './format.ts';

const root = resolve(import.meta.dirname, '..');
const changed = ciChanges(root);
const runtimeChanged = changed?.some(path => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.nvmrc'].includes(path));
const tsFull = !changed || runtimeChanged || changed.some(path => ['tsfmt.json', 'build/format.ts', 'build/formatCI.ts', 'build/ciChanges.ts'].includes(path));
const configFull = !changed || runtimeChanged || changed.some(path => ['.prettierrc.toml', '.prettierignore', 'build/formatCI.ts', 'build/ciChanges.ts'].includes(path));
const sources = sourceNames(changed ?? []).filter(path => existsSync(resolve(root, path)));
const configs: string[] = [];
for (const path of changed ?? []) {
	if (!/\.(?:jsonc?|ya?ml|md|css|html)$/.test(path) || !existsSync(resolve(root, path))) { continue; }
	if (!(await getFileInfo(resolve(root, path), { ignorePath: resolve(root, '.prettierignore') })).ignored) { configs.push(path); }
}

function check(args: readonly string[]): number {
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
	if (result.error) { throw result.error; }
	return result.status ?? 1;
}

console.log(`Formatting scope: TS ${tsFull ? 'full' : sources.length}; config ${configFull ? 'full' : configs.length}.`);
// A deleted or generated-only change is a legitimate empty scope. Local
// formatter commands still reject accidentally misspelled explicit paths.
const tsStatus = tsFull || sources.length ? check(['build/format.ts', '--check', ...(tsFull ? [] : sources)]) : 0;
const configStatus = configFull || configs.length
	? check([fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs')), '--check', ...(configFull ? ['**/*.{json,jsonc,yml,yaml,md,css,html}'] : configs)]) : 0;
process.exitCode = tsStatus || configStatus;
