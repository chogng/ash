import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { format, verifyFormatting } from './format.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const bun = join(repositoryRoot, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');

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

test('the formatting CLI checks TypeScript SDK and extension author sources', t => {
	for (const root of ['sdk/typescript', 'examples/extensions']) {
		const directory = mkdtempSync(join(repositoryRoot, root, '.formatter-test-'));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		for (const name of ['entry.ts', 'runtime.js']) writeFileSync(join(directory, name), 'export const value=1\n');
		const source = relative(repositoryRoot, directory);
		const checked = spawnSync(process.execPath, [join(repositoryRoot, 'build/format.ts'), '--check', source], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(checked.status, 1, checked.stdout + checked.stderr);
		assert.match(checked.stdout, /checked 2 files; 2 unformatted/u);
		const fixed = spawnSync(process.execPath, [join(repositoryRoot, 'build/format.ts'), '--write', source], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
		for (const name of ['entry.ts', 'runtime.js']) assert.equal(readFileSync(join(directory, name), 'utf8'), 'export const value = 1;\n');
	}
});

test('the CLI checks without writing, fixes both languages, and leaves generated inputs unchanged', t => {
	const directory = mkdtempSync(join(repositoryRoot, 'test/.formatter-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const input = 'function example(){\n  return 1+2\n}\n';
	const excluded = ['generated/contract.ts', 'fixtures/input.ts', 'node_modules/dependency.js', 'types.d.mts'];
	for (const name of ['file [with spaces].ts', 'script.js', ...excluded]) {
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
	const invoke = (script: string, ...paths: string[]): ReturnType<typeof spawnSync> => spawnSync(executable, [...prefix, script, source, ...paths], { cwd: repositoryRoot, encoding: 'utf8' });
	const checked = invoke('format:ts');
	assert.equal(checked.status, 1, String(checked.stdout) + String(checked.stderr));
	assert.equal(readFileSync(join(directory, 'file [with spaces].ts'), 'utf8'), input);
	assert.match(String(checked.stdout), /checked 2 files; 2 unformatted/);
	const literal = spawnSync(executable, [...prefix, 'format:ts', join(source, 'file [with spaces].ts')], { cwd: repositoryRoot, encoding: 'utf8' });
	assert.equal(literal.status, 1, String(literal.stdout) + String(literal.stderr));
	assert.match(String(literal.stdout), /checked 1 files; 1 unformatted/);
	const overlapping = invoke('format:ts', join(source, 'file [with spaces].ts'));
	assert.equal(overlapping.status, 1, String(overlapping.stdout) + String(overlapping.stderr));
	assert.match(String(overlapping.stdout), /checked 2 files; 2 unformatted/);
	const missing = invoke('format:ts', join(source, 'missing.ts'));
	assert.equal(missing.status, 1);
	assert.match(String(missing.stderr), /No first-party TypeScript or JavaScript sources matched/);
	const outside = invoke('format:ts', '../outside.ts');
	assert.equal(outside.status, 1);
	assert.match(String(outside.stderr), /Source path must belong to the repository/);
	const fixed = invoke('format:ts:fix');
	assert.equal(fixed.status, 0, String(fixed.stdout) + String(fixed.stderr));
	assert.equal(readFileSync(join(directory, 'file [with spaces].ts'), 'utf8'), 'function example() {\n\treturn 1 + 2;\n}\n');
	assert.equal(invoke('format:ts').status, 0);
	for (const name of excluded) {
		assert.equal(readFileSync(join(directory, name), 'utf8'), input);
	}
	for (const path of [join(directory, 'types.d.mts'), 'src/ash/base/common/lxiconsLibrary.ts', 'src/ash/base/browser/dompurify/dompurify.js', 'src/ash/base/common/marked/marked.js']) {
		const unsupported = spawnSync(process.execPath, [join(repositoryRoot, 'build/format.ts'), '--check', path], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(unsupported.status, 1);
		assert.match(unsupported.stderr, /No first-party TypeScript or JavaScript sources matched/);
	}
});

test('Bun selects configuration and prose while excluding code, generated inputs, fixtures, and locks', t => {
	const directory = mkdtempSync(join(repositoryRoot, 'test/.formatter-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const ignored = ['code.ts', 'script.js', '.build/schema.json', 'generated/example.json', 'vendor/example.json', 'output/state.json', '.playwright-test/capture.yml', 'fixtures/example.json', 'test-data/example.json', 'testData/example.json', 'snapshots/example.md', '.pytest_cache/README.md', 'pnpm-lock.yaml', 'AGENTS.md', 'SKILL.md', 'example_prompt.md', 'example_instructions.md'];
	const included = ['file [with spaces].json', 'docs/notes.md', 'workflow.yml'];
	for (const name of [...ignored, ...included]) {
		const path = join(directory, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, 'unformatted input\n');
	}
	const copied = ['src/ash/base/browser/dompurify/cgmanifest.json', 'src/ash/base/common/marked/cgmanifest.json'];
	const files = [...ignored, ...included].map(name => relative(repositoryRoot, join(directory, name)).replaceAll('\\', '/'));
	const checked = spawnSync(bun, ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--list-files', '--', ...files, ...copied], { cwd: repositoryRoot, encoding: 'utf8' });
	assert.equal(checked.status, 0, checked.stdout + checked.stderr);
	assert.deepEqual(checked.stdout.trim().split(/\r?\n/).sort(), included.map(name => relative(repositoryRoot, join(directory, name)).replaceAll('\\', '/')).sort());
	for (const file of files.slice(0, ignored.length)) {
		const formatted = spawnSync(bun, ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--stdin-filepath', file], { cwd: repositoryRoot, input: 'unformatted input\n', encoding: 'utf8' });
		assert.equal(formatted.status, 0, formatted.stdout + formatted.stderr);
		assert.equal(formatted.stdout, 'unformatted input\n', `Editor stdin preserves ignored files: ${file}`);
	}
});

test('Bun leaves generated JSON to its owning serializers and checks neighboring handwritten files', t => {
	const generated = new Map<string, string>();
	const handwritten: string[] = [];
	const input = '{"manual":true}\n';
	for (const file of ['build/lib/stylelint/ash-known-variables.json', 'crates/config/schema.json', 'crates/model-provider-info/models.schema.json']) {
		const path = resolve(repositoryRoot, file);
		generated.set(file, readFileSync(path, 'utf8'));
		const directory = mkdtempSync(join(dirname(path), '.formatter-test-'));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const neighbor = join(directory, 'handwritten.json');
		writeFileSync(neighbor, input);
		handwritten.push(relative(repositoryRoot, neighbor).replaceAll('\\', '/'));
	}
	const checked = spawnSync(bun, ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--list-different', ...generated.keys(), ...handwritten], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
	assert.equal(checked.status, 1, checked.stdout + checked.stderr);
	assert.deepEqual(checked.stdout.trim().split(/\r?\n/).sort(), [...handwritten].sort());
	for (const [file, contents] of generated) assert.equal(readFileSync(resolve(repositoryRoot, file), 'utf8'), contents);
	for (const file of handwritten) assert.equal(readFileSync(resolve(repositoryRoot, file), 'utf8'), input);
});

test('the configured editor command and CI formatter produce identical bytes for every configuration language', t => {
	const settings = JSON.parse(readFileSync(join(repositoryRoot, '.vscode/settings.json'), 'utf8'));
	const editor = settings['simpleLspClient.formatters'].bun;
	const directory = mkdtempSync(join(repositoryRoot, 'test/.formatter-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const cases = [
		['json', join(directory, 'file [with spaces].json'), '{"value":1,"nested":{"enabled":true}}\n'],
		['jsonc', join(repositoryRoot, '.vscode', `${basename(directory)}.jsonc`), '{\n// retained comment\n"value":1,\n"nested":{"enabled":true},\n}\n'],
		['yaml', join(directory, 'workflow.yml'), 'name:   example\non: [push,pull_request]\n'],
		['markdown', join(directory, 'notes.md'), '#   Heading\n\n```ts\nconst value=1\n```\n'],
		['css', join(directory, 'style.css'), '.example{color:red;padding:0  1px}\n'],
		['html', join(directory, 'index.html'), '<main><p>example</p><p>text</p></main>\n'],
		['json', join(directory, 'literal $(printf path) & %NAME%.json'), '{"value":1,"nested":{"enabled":true}}\n'],
	];
	t.after(() => rmSync(cases[1][1], { force: true }));
	for (const [language, file, input] of cases) {
		assert.ok(editor.filetypes.includes(language), language);
		// Resolve the same language override the editor uses, including single-language settings.
		const group = settings['[json][jsonc][yaml][markdown][css][html]'];
		assert.equal(settings[`[${language}]`]?.['editor.defaultFormatter'] ?? group['editor.defaultFormatter'], 'wdomitrz.simple-lsp-client');
		writeFileSync(file, input);
		const template = editor.cmd;
		assert.ok(Array.isArray(template), 'The editor must pass arguments without a shell.');
		assert.equal(template[0], '${workspaceFolder}/node_modules/bun/bun');
		const command = template.map((argument: string) => argument.replaceAll('${workspaceFolder}', repositoryRoot).replaceAll('${file}', file));
		assert.equal(command.at(-1), file, 'The file name must remain one literal argument.');
		const formatted = spawnSync(command[0], command.slice(1), { cwd: repositoryRoot, input, encoding: 'utf8' });
		assert.equal(formatted.status, 0, formatted.stdout + formatted.stderr);
		assert.notEqual(formatted.stdout, input, language);
		assert.equal(readFileSync(file, 'utf8'), input, 'Editor formatting must use the unsaved buffer without writing files.');
		const written = spawnSync(bun, ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--write', '--', file], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(written.status, 0, written.stdout + written.stderr);
		assert.equal(readFileSync(file, 'utf8'), formatted.stdout, language);
		const checked = spawnSync(bun, ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--check', '--', file], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(checked.status, 0, checked.stdout + checked.stderr);
		if (language === 'jsonc') assert.ok(formatted.stdout.includes('\n\t"value": 1,'), 'Workspace JSON keeps tab indentation.');
		if (language === 'markdown') assert.ok(formatted.stdout.includes('```ts\nconst value=1\n```'), 'Fenced code retains its owning language formatting.');
	}
});
