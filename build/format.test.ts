import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { format as formatSource } from './format.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const bun = join(repositoryRoot, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');

function format(file: string, input: string): string {
	const arguments_ = /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)
		? [join(repositoryRoot, 'build/format.ts'), '--stdin-filepath', file]
		: ['fmt', '--no-script', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--stdin-filepath', file];
	const result = spawnSync(bun, arguments_, {
		cwd: repositoryRoot,
		input,
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
	return result.stdout;
}

test('TypeScript formats source buffers without changing quotes or writing files', () => {
	const input = 'function example(){\n  const message="hello"\n  consume(message,1)\n}\n';
	const expected = 'function example() {\n\tconst message = "hello";\n\tconsume(message, 1);\n}\n';
	assert.equal(format('test/example.ts', input), expected);
	assert.equal(format('test/example.ts', expected), expected);
});

test('TypeScript preserves single-line imports without imposing a print width', () => {
	const input = "import type { ISessionProviderScope, ISessionProviderScopeService, SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';\n";
	assert.equal(format('test/example.ts', input), input);
});

test('TypeScript preserves both compact objects and multiline settings', () => {
	const input = `const compact = { id: 'on', label: 'On' };
const configuration = {
	setting: {
		valueType: 'select',
		title: 'Reduce motion',
		description: 'Limit non-essential animation throughout the Workbench.',
		options: triStateSettingOptions,
	},
};
`;
	assert.equal(format('test/example.ts', input), input);
});

test('TypeScript preserves multiline imports, signatures, and calls', () => {
	const input = `import type {
	ISessionProviderScope,
	ISessionProviderScopeService,
} from '../../../../browser/agentHost/sessionProviderScopeService.js';

function example(
	value: string,
	options: Options,
): void {
	consume(
		value,
		options,
	);
}
`;
	assert.equal(format('test/example.ts', input), input);
});

test('TypeScript formats nested call chains to stable output in one pass', () => {
	const input = `class Preview {
	async example() {
		try {
			return lines.map((_, index) =>
				preview.getLanguageTokens(lineNumber+index).map(token => ({
					...token,
					range: new Range(index + 1, token.range.startColumn, index + 1, token.range.endColumn),
				})),
			);
		} finally { preview.dispose(); }
	}
}
`;
	const formatted = format('test/example.ts', input);
	assert.notEqual(formatted, input);
	assert.equal(format('test/example.ts', formatted), formatted);
});

test('batched whitespace edits retain semicolons at replaced whitespace and Unicode offsets', () => {
	const input = [
		'const value=1   ',
		'const label="中文🙂"  ',
		'consume(',
		' value,',
		' label,',
		')  ',
		'',
	].join('\n');
	const expected = [
		'const value = 1;',
		'const label = "中文🙂";',
		'consume(',
		'\tvalue,',
		'\tlabel,',
		');',
		'',
	].join('\n');
	assert.equal(formatSource('test/example.ts', input), expected);
	assert.equal(formatSource('test/example.ts', expected), expected);
	assert.equal(formatSource('test/example.ts', ''), '');
});

test('large CLI batches match serial formatting with snapshot settings in Node and Bun', t => {
	const directory = mkdtempSync(join(repositoryRoot, 'test/.formatter-test-'));
	const snapshot = mkdtempSync(join(tmpdir(), 'ash format snapshot '));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	t.after(() => rmSync(snapshot, { recursive: true, force: true }));
	const options = {
		...JSON.parse(readFileSync(join(repositoryRoot, 'tsfmt.json'), 'utf8')),
		convertTabsToSpaces: true,
		indentSize: 2,
		tabSize: 2,
	};
	writeFileSync(join(snapshot, 'tsfmt.json'), JSON.stringify(options));
	const inputs = [
		[
			'ts',
			[
				'import type { One, Two } from "./types.js"',
				'const settings={',
				' title: "中文🙂",',
				' nested: { enabled:true },',
				'}',
				'',
			].join('\n'),
		],
		[
			'js',
			[
				'const run=(value)=>{',
				' console.log(',
				' value,',
				' )  ',
				'}',
				'',
			].join('\n'),
		],
		[
			'tsx',
			[
				'export const View=()=> (',
				' <div title="中文🙂">',
				' <span>{value}</span>',
				' </div>',
				')',
				'',
			].join('\n'),
		],
		['jsx', 'export const View=()=> <div title="中文🙂"/>\n'],
		[
			'mts',
			[
				'export const values=[',
				' 1,',
				' 2,',
				']',
				'',
			].join('\n'),
		],
		['cts', 'const value=1   \nconst label="中文🙂"  \n'],
		['mjs', 'export const compact={id:"on", label:"On"}\n'],
		[
			'cjs',
			[
				'module.exports={',
				' value: true,',
				'}',
				'',
			].join('\n'),
		],
	];
	const files = Array.from({ length: 500 }, (_, index) => {
		const [extension, body] = inputs[index % inputs.length];
		const file = join(directory, `source [${index.toString().padStart(3, '0')}].${extension}`);
		const name = relative(repositoryRoot, file);
		const target = join(snapshot, name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(file, 'const workingTree = "untouched";\n');
		const input = `// snapshot ${index}\n${body}`;
		return {
			file,
			name,
			target,
			input,
			expected: formatSource(target, input, options),
		};
	});
	const scope = relative(repositoryRoot, directory);
	for (const runtime of [process.execPath, bun]) {
		for (const { target, input } of files) {
			writeFileSync(target, input);
		}
		const invoke = (mode: string): ReturnType<typeof spawnSync> => spawnSync(
			runtime,
			[join(repositoryRoot, 'build/format.ts'), mode, '--content-root', snapshot, scope],
			{
				cwd: repositoryRoot,
				encoding: 'utf8',
				timeout: 30_000,
			},
		);
		const checked = invoke('--check');
		assert.equal(checked.status, 1, String(checked.stdout) + String(checked.stderr));
		assert.match(String(checked.stdout), /checked 500 TypeScript\/JavaScript files; 500 changed\./);
		const diagnostics = files
			.map(({ name }) => `File not formatted: ${name.replaceAll('\\', '/')}`)
			.sort()
			.join('\n');
		assert.equal(String(checked.stderr), diagnostics + '\n');
		for (const { target, input } of files) {
			assert.equal(readFileSync(target, 'utf8'), input);
		}
		const fixed = invoke('--write');
		assert.equal(fixed.status, 0, String(fixed.stdout) + String(fixed.stderr));
		for (const { target, expected, file } of files) {
			assert.equal(readFileSync(target, 'utf8'), expected, target);
			assert.equal(readFileSync(file, 'utf8'), 'const workingTree = "untouched";\n');
		}
		const rechecked = invoke('--check');
		assert.equal(rechecked.status, 0, String(rechecked.stdout) + String(rechecked.stderr));
		assert.match(String(rechecked.stdout), /checked 500 TypeScript\/JavaScript files; 0 changed\./);
		// A parser failure in one worker must fail the check and release the other workers.
		const invalid = 'const value = ' + '('.repeat(10_000) + '1' + ')'.repeat(10_000) + ';\n';
		writeFileSync(files[0].target, invalid);
		const failed = invoke('--check');
		assert.equal(failed.error, undefined);
		assert.equal(failed.status, 1, String(failed.stdout) + String(failed.stderr));
		assert.match(String(failed.stderr), /call stack|stack overflow/i);
		assert.doesNotMatch(String(failed.stdout), /TypeScript: checked/);
		assert.equal(readFileSync(files[0].target, 'utf8'), invalid);
	}
});

test('the formatting CLI checks TypeScript SDK and extension author sources', t => {
	for (const root of ['sdk/typescript', 'examples/extensions']) {
		const directory = mkdtempSync(join(repositoryRoot, root, '.formatter-test-'));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		writeFileSync(join(directory, 'entry.ts'), 'export const value=1\n');
		writeFileSync(join(directory, 'runtime.js'), 'export const label="runtime"\n');
		const source = relative(repositoryRoot, directory);
		const checked = spawnSync(process.execPath, [join(repositoryRoot, 'build/format.ts'), '--check', source], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(checked.status, 1, checked.stdout + checked.stderr);
		assert.match(checked.stdout, /checked 2 TypeScript\/JavaScript files/u);
		const fixed = spawnSync(process.execPath, [join(repositoryRoot, 'build/format.ts'), '--write', source], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
		assert.equal(readFileSync(join(directory, 'entry.ts'), 'utf8'), 'export const value = 1;\n');
		assert.equal(readFileSync(join(directory, 'runtime.js'), 'utf8'), 'export const label = "runtime";\n');
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
	assert.match(String(checked.stdout), /checked 2 TypeScript\/JavaScript files/);
	const literal = spawnSync(executable, [...prefix, 'format:ts', join(source, 'file [with spaces].ts')], { cwd: repositoryRoot, encoding: 'utf8' });
	assert.equal(literal.status, 1, String(literal.stdout) + String(literal.stderr));
	assert.match(String(literal.stdout), /checked 1 TypeScript\/JavaScript files/);
	const overlapping = invoke('format:ts', join(source, 'file [with spaces].ts'));
	assert.equal(overlapping.status, 1, String(overlapping.stdout) + String(overlapping.stderr));
	assert.match(String(overlapping.stdout), /checked 2 TypeScript\/JavaScript files/);
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
	for (const path of [join(directory, 'types.d.mts'), 'src/ash/base/browser/dompurify/dompurify.js', 'src/ash/base/common/marked/marked.js']) {
		const unsupported = spawnSync(process.execPath, [join(repositoryRoot, 'build/format.ts'), '--check', path], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(unsupported.status, 1);
		assert.match(unsupported.stderr, /No first-party TypeScript or JavaScript sources matched/);
	}
});

test('Bun selects source, configuration and prose while preserving generated inputs, fixtures, and locks', t => {
	const directory = mkdtempSync(join(repositoryRoot, 'test/.formatter-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const ignored = [
		'contract.d.ts',
		'contract.d.mts',
		'contract.d.cts',
		'typings/contract.ts',
		'.build/schema.json',
		'generated/example.json',
		'vendor/example.json',
		'output/state.json',
		'.playwright-test/capture.yml',
		'fixtures/example.json',
		'test-data/example.json',
		'testData/example.json',
		'snapshots/example.md',
		'.pytest_cache/README.md',
		'pnpm-lock.yaml',
		'AGENTS.md',
		'SKILL.md',
		'example_prompt.md',
		'example_instructions.md',
	];
	const included = ['code.ts', 'script.js', 'contract.generated.ts', 'file [with spaces].json', 'docs/notes.md', 'workflow.yml'];
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
		const formatted = spawnSync(bun, ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--stdin-filepath', file], {
			cwd: repositoryRoot,
			input: 'unformatted input\n',
			encoding: 'utf8',
		});
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
	const checked = spawnSync(bun, ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--list-different', ...generated.keys(), ...handwritten], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		windowsHide: true,
	});
	assert.equal(checked.status, 1, checked.stdout + checked.stderr);
	assert.deepEqual(checked.stdout.trim().split(/\r?\n/).sort(), [...handwritten].sort());
	for (const [file, contents] of generated) assert.equal(readFileSync(resolve(repositoryRoot, file), 'utf8'), contents);
	for (const file of handwritten) assert.equal(readFileSync(resolve(repositoryRoot, file), 'utf8'), input);
});

test('the workspace buffer commands and CI formatters produce identical bytes for every supported frontend language', t => {
	const settings = JSON.parse(readFileSync(join(repositoryRoot, '.vscode/settings.json'), 'utf8'));
	const directory = mkdtempSync(join(repositoryRoot, 'test/.formatter-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const workspaceJsonc = join(repositoryRoot, '.vscode', `${basename(directory)}.jsonc`);
	const cases = [
		['typescript', join(directory, 'source [with spaces].ts'), 'const value={name:"example"}\n'],
		['typescriptreact', join(directory, 'component.tsx'), 'export const View=()=> <div title="example"/>\n'],
		['javascript', join(directory, 'script.js'), 'const value={name:"example"}\n'],
		['javascriptreact', join(directory, 'component.jsx'), 'export const View=()=> <div title="example"/>\n'],
		['typescript', join(directory, 'module.mts'), 'export const value={name:"example"}\n'],
		['typescript', join(directory, 'module.cts'), 'export const value={name:"example"}\n'],
		['javascript', join(directory, 'module.mjs'), 'export const value={name:"example"}\n'],
		['javascript', join(directory, 'module.cjs'), 'exports.value={name:"example"}\n'],
		['json', join(directory, 'file [with spaces].json'), '{"value":1,"nested":{"enabled":true}}\n'],
		['jsonc', workspaceJsonc, '{\n// retained comment\n"value":1,\n"nested":{"enabled":true},\n}\n'],
		['yaml', join(directory, 'workflow.yml'), 'name:   example\non: [push,pull_request]\n'],
		['markdown', join(directory, 'notes.md'), '#   Heading\n\n```ts\nconst value=1\n```\n'],
		['css', join(directory, 'style.css'), '.example{color:red;padding:0  1px}\n'],
		['html', join(directory, 'index.html'), '<main><p>example</p><p>text</p></main>\n'],
		['json', join(directory, 'literal $(printf path) & %NAME%.json'), '{"value":1,"nested":{"enabled":true}}\n'],
	];
	t.after(() => rmSync(workspaceJsonc, { force: true }));
	for (const [language, file, input] of cases) {
		// Resolve the same language override the editor uses, including single-language settings.
		const source = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language);
		const editor = settings['simpleLspClient.formatters'][source ? 'typescript' : 'bun'];
		assert.ok(editor.filetypes.includes(language), language);
		const group = settings[source ? '[typescript][typescriptreact][javascript][javascriptreact]' : '[json][jsonc][yaml][markdown][css][html]'];
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
		const arguments_ = source ? [join(repositoryRoot, 'build/format.ts')] : ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore'];
		const written = spawnSync(bun, [...arguments_, '--write', ...(source ? [] : ['--']), file], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(written.status, 0, written.stdout + written.stderr);
		assert.equal(readFileSync(file, 'utf8'), formatted.stdout, language);
		const checked = spawnSync(bun, [...arguments_, '--check', ...(source ? [] : ['--']), file], { cwd: repositoryRoot, encoding: 'utf8' });
		assert.equal(checked.status, 0, checked.stdout + checked.stderr);
		if (language === 'jsonc') assert.ok(formatted.stdout.includes('\n\t"value": 1,'), 'Workspace JSON keeps tab indentation.');
		if (language === 'markdown') assert.ok(formatted.stdout.includes('```ts\nconst value=1\n```'), 'Fenced code retains its owning language formatting.');
	}
});
