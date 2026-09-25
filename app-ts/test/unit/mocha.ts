import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

interface Selection {
	readonly runs: readonly string[];
	readonly runGlob?: string;
	readonly grep?: string;
	readonly timeout: number;
}

const desktopDirectory = resolve(import.meta.dirname, '../..');
const outputDirectory = resolve(desktopDirectory, '../.build/app-ts/test');

export function runUnitTests(patterns: readonly string[], editorEnvironment: boolean): void {
	const requiredVersion = readFileSync(resolve(desktopDirectory, '../.nvmrc'), 'utf8').trim();
	if (process.versions.node.split('.')[0] !== requiredVersion.split('.')[0]) {
		throw new Error(`Unit tests require the Node major version specified in .nvmrc (${requiredVersion}); found ${process.version}.`);
	}
	// TypeScript resolves marked.d.ts but does not emit its adjacent JavaScript implementation.
	const markedSource = resolve(desktopDirectory, 'src/ash/base/common/marked/marked.js');
	const markedOutput = resolve(outputDirectory, 'src/ash/base/common/marked/marked.js');
	mkdirSync(dirname(markedOutput), { recursive: true });
	copyFileSync(markedSource, markedOutput);
	const selection = parseSelection(process.argv.slice(2));
	let names: string[];
	if (selection.runs.length > 0) {
		names = selection.runs.map(sourceFile);
	} else if (selection.runGlob) {
		names = globSync(selection.runGlob, { cwd: outputDirectory });
	} else {
		names = patterns.flatMap(pattern => globSync(pattern, { cwd: outputDirectory }));
	}
	const files = [...new Set(names.map(name => resolve(outputDirectory, name)))].sort();
	if (files.length === 0) {
		throw new Error('No compiled unit tests matched the requested files');
	}

	const failed: string[] = [];
	for (const file of files) {
		if (!file.startsWith(`${outputDirectory}${sep}`) || !existsSync(file)) {
			throw new Error(`Compiled unit test does not exist: ${file}`);
		}
		const result = spawnSync(process.execPath, [
			'--import', './test/unit/ignore-css-imports.ts',
			...(editorEnvironment ? ['--import', './test/unit/editor-environment.ts'] : []),
			'node_modules/mocha/bin/mocha.js',
			'--ui', 'tdd',
			'--timeout', String(selection.timeout),
			...(selection.grep ? ['--grep', selection.grep] : []),
			file,
		], { cwd: desktopDirectory, stdio: 'inherit', windowsHide: true });
		if (result.error) throw result.error;
		if (result.status !== 0) failed.push(file);
	}

	process.stdout.write(`Mocha: ${files.length - failed.length}/${files.length} test files passed\n`);
	if (failed.length > 0) {
		process.stderr.write(`Failed test files:\n${failed.join('\n')}\n`);
		process.exitCode = 1;
	}
}

function sourceFile(value: string): string {
	if (!value.startsWith('src/') && !value.startsWith('test/')) {
		throw new Error(`--run expects a path relative to app-ts: ${value}`);
	}
	return value.endsWith('.ts') ? `${value.slice(0, -3)}.js` : value;
}

function parseSelection(args: readonly string[]): Selection {
	const runs: string[] = [];
	let runGlob: string | undefined;
	let grep: string | undefined;
	let timeout = 60_000;
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		const value = args[index + 1];
		if (!value) throw new Error(`Missing value for ${option}`);
		switch (option) {
			case '--run': runs.push(value); break;
			case '--runGlob': runGlob = value; break;
			case '--grep': grep = value; break;
			case '--timeout': {
				timeout = Number(value);
				if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error(`Invalid test timeout: ${value}`);
				break;
			}
			default: throw new Error(`Unsupported unit test option: ${option}`);
		}
		index += 1;
	}
	if (runs.length > 0 && runGlob) throw new Error('--run and --runGlob cannot be combined');
	return { runs, runGlob, grep, timeout };
}
