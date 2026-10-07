import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { getFileInfo, resolveConfig } from 'prettier';
import { format, verifyFormatting } from './format.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');

test('TypeScript formatting preserves long imports and short calls while inserting tabs and semicolons', () => {
	const declaration = "import { firstLongImportedName, secondLongImportedName, thirdLongImportedName } from './a/module/with/a/long/path.js';";
	const input = `${declaration}\nfunction example(){\n  const message='hello'\n  consume(message,1)\n}\n`;
	const expected = `${declaration}\nfunction example() {\n\tconst message = 'hello';\n\tconsume(message, 1);\n}\n`;
	assert.equal(format('example.ts', input), expected);
	assert.equal(format('example.ts', expected), expected);
	assert.equal(verifyFormatting('example.ts', expected), true);
	assert.equal(verifyFormatting('example.ts', input), false);
});

test('formatting retains a semicolon inserted at the same offset as a whitespace replacement', () => {
	const input = 'type Example = {\n\treadonly nested: {\n\t\tinvoke(): Promise<unknown>;\n\t} };\n';
	const expected = 'type Example = {\n\treadonly nested: {\n\t\tinvoke(): Promise<unknown>;\n\t};\n};\n';
	assert.equal(format('example.ts', input), expected);
	assert.equal(format('example.ts', expected), expected);
});

test('the CLI checks without writing, fixes both languages, and leaves generated inputs unchanged', t => {
	const directory = mkdtempSync(join(repositoryRoot, 'test/.formatter-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const input = 'function example(){\n  return 1+2\n}\n';
	const excluded = ['generated/contract.ts', 'fixtures/input.ts', 'node_modules/dependency.js', 'types.d.mts'];
	for (const name of ['file with spaces.ts', 'script.js', ...excluded]) {
		const path = join(directory, name);
		mkdirSync(resolve(path, '..'), { recursive: true });
		writeFileSync(path, input);
	}
	const source = relative(repositoryRoot, directory);
	const packageManager = process.env.npm_execpath;
	assert.ok(packageManager, 'Run these tests through pnpm test:format.');
	const isScript = /\.[cm]?js$/.test(packageManager);
	const executable = isScript ? process.execPath : packageManager;
	const prefix = isScript ? [packageManager] : [];
	const invoke = (script: string): ReturnType<typeof spawnSync> => spawnSync(executable, [...prefix, script, source], { cwd: repositoryRoot, encoding: 'utf8' });
	const checked = invoke('format:ts');
	assert.equal(checked.status, 1, String(checked.stdout) + String(checked.stderr));
	assert.equal(readFileSync(join(directory, 'file with spaces.ts'), 'utf8'), input);
	assert.match(String(checked.stdout), /checked 2 files; 2 unformatted/);
	const fixed = invoke('format:ts:fix');
	assert.equal(fixed.status, 0, String(fixed.stdout) + String(fixed.stderr));
	assert.equal(readFileSync(join(directory, 'file with spaces.ts'), 'utf8'), 'function example() {\n\treturn 1 + 2;\n}\n');
	assert.equal(invoke('format:ts').status, 0);
	for (const name of excluded) {
		assert.equal(readFileSync(join(directory, name), 'utf8'), input);
	}
	for (const path of [join(directory, 'types.d.mts'), 'src/ash/base/common/productIcons.ts', 'src/ash/base/browser/dompurify/dompurify.js', 'src/ash/base/common/marked/marked.js']) {
		const unsupported = spawnSync(process.execPath, [join(repositoryRoot, 'build/format.ts'), '--check', path], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(unsupported.status, 1);
		assert.match(unsupported.stderr, /No first-party TypeScript or JavaScript sources matched/);
	}
});

test('Prettier owns configuration and prose but excludes code, generated contracts, fixtures, and locks', async () => {
	const ignored = ['build/lib/formatter.ts', 'build/script.js', 'crates/app-server-protocol/schema/typescript/protocol.ts', 'crates/app-server-protocol/schema/json/schema.json', 'generated/example.json', 'third_party/v8/runtime-lock.json', 'test/fixtures/example.json', 'src/ash/base/browser/dompurify/cgmanifest.json', 'src/ash/base/common/marked/cgmanifest.json', '.pytest_cache/README.md', 'pnpm-lock.yaml'];
	for (const file of ignored) {
		assert.equal((await getFileInfo(resolve(repositoryRoot, file), { ignorePath: join(repositoryRoot, '.prettierignore') })).ignored, true, file);
	}
	for (const file of ['package.json', 'docs/build.md', '.github/workflows/frontend.yml']) {
		assert.equal((await getFileInfo(resolve(repositoryRoot, file), { ignorePath: join(repositoryRoot, '.prettierignore') })).ignored, false, file);
	}
	assert.equal((await resolveConfig(join(repositoryRoot, 'docs/build.md')))?.embeddedLanguageFormatting, 'off');
});
