import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('the preparation owner runs each stage once and stops before consumers on failure', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-prepare-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const directory of ['build/protocol', 'build/resources/icons', 'build/builtin', 'node_modules']) { await mkdir(join(root, directory), { recursive: true }); }
	await writeFile(join(root, 'build/treeSitterRegistry.ts'), `import { record } from '../record.ts'; export async function generateTreeSitterRegistry() { record('registry'); }`);
	await writeFile(join(root, 'build/languageRegistry.ts'), `import { record } from '../record.ts'; export async function generateLanguageRegistry() { record('languages'); }`);
	await copyFile(join(import.meta.dirname, 'prepare.ts'), join(root, 'build/prepare.ts'));
	await symlink(resolve(import.meta.dirname, '../node_modules/bun'), join(root, 'node_modules/bun'), process.platform === 'win32' ? 'junction' : 'dir');
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	await writeFile(join(root, 'record.ts'), `import { appendFileSync } from 'node:fs'; export function record(stage) { appendFileSync(new URL('./operations.log', import.meta.url), stage + '\\n'); if (process.env.FAIL_PREP_STAGE === stage) throw new Error(stage + ' failed'); }`);
	await writeFile(join(root, 'build/treeSitter.ts'), `import { record } from '../record.ts'; export async function verifyTreeSitterGrammars() { record('grammars'); }`);
	for (const [file, symbol, stage] of [
		['protocol/generate.ts', 'generateProtocol', 'protocol'],
		['resources/localization.ts', 'generateLocalization', 'localization'],
		['builtin/extensions.ts', 'prepareBuiltinExtensions', 'extensions'],
	]) { await writeFile(join(root, 'build', file), `import { record } from '../../record.ts'; export async function ${symbol}() { record('${stage}'); }`); }
	await writeFile(join(root, 'build/resources/icons/generate.ts'), `import { record } from '../../../record.ts'; record('icons');`);
	await writeFile(join(root, 'tsconfig.common.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ['ES2022'] }, files: ['common.ts'] }));
	for (const failure of ['languages', 'registry', 'protocol', 'localization', 'common', 'grammars', 'extensions', 'icons', '']) {
		await writeFile(join(root, 'operations.log'), '');
		await writeFile(join(root, 'common.ts'), `export const value: number = ${failure === 'common' ? "'wrong'" : '1'};`);
		const result = spawnSync(process.execPath, [join(root, 'build/prepare.ts')], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, FAIL_PREP_STAGE: failure } });
		assert.ifError(result.error);
		assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
		const stages = ['languages', 'registry', 'protocol', 'localization', 'grammars', 'extensions', 'icons'];
		const expected = failure === 'common' ? stages.slice(0, 4) : failure ? stages.slice(0, stages.indexOf(failure) + 1) : stages;
		assert.deepEqual((await readFile(join(root, 'operations.log'), 'utf8')).trim().split('\n'), expected);
		if (failure === 'common') { assert.match(result.stdout + result.stderr, /TS2322/); }
	}
});
