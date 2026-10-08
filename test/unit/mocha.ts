import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

interface Selection {
	readonly runs: readonly string[];
	readonly runGlob?: string;
	readonly grep?: string;
	readonly timeout: number;
	readonly jobs: number;
}

const desktopDirectory = resolve(import.meta.dirname, '../..');
const outputDirectory = resolve(desktopDirectory, '.build/desktop/test');

export async function runUnitTests(patterns: readonly string[], editorEnvironment: boolean): Promise<void> {
	const requiredVersion = readFileSync(resolve(desktopDirectory, '.nvmrc'), 'utf8').trim();
	if (process.versions.node.split('.')[0] !== requiredVersion.split('.')[0]) {
		throw new Error(`Unit tests require the Node major version specified in .nvmrc (${requiredVersion}); found ${process.version}.`);
	}
	// TypeScript resolves vendored declarations but does not emit their adjacent JavaScript implementations.
	for (const path of ['src/ash/base/common/marked/marked.js', 'src/ash/base/browser/dompurify/dompurify.js']) {
		const output = resolve(outputDirectory, path);
		mkdirSync(dirname(output), { recursive: true });
		copyFileSync(resolve(desktopDirectory, path), output);
	}
	const selection = parseSelection(process.argv.slice(2));
	let names: string[];
	if (selection.runs.length > 0) {
		names = selection.runs.map(sourceFile);
	} else if (selection.runGlob) {
		names = globSync(selection.runGlob, { cwd: outputDirectory });
	} else {
		names = patterns.flatMap(pattern => {
			const matches = globSync(pattern, { cwd: outputDirectory });
			if (matches.length === 0) {
				throw new Error(`No compiled unit tests matched the required pattern: ${pattern}`);
			}
			return matches;
		});
	}
	const files = [...new Set(names.map(name => resolve(outputDirectory, name)))].sort();
	if (files.length === 0) {
		throw new Error('No compiled unit tests matched the requested files');
	}

	const failed: string[] = [];
	let executedTests = 0;
	const resultDirectory = mkdtempSync(resolve(tmpdir(), 'ash-unit-results-'));
	try {
		// Validate the complete selection before starting any child processes.
		for (const file of files) {
			if (!file.startsWith(`${outputDirectory}${sep}`) || !existsSync(file)) {
				throw new Error(`Compiled unit test does not exist: ${file}`);
			}
		}
		let nextFile = 0;
		const workers = Array.from({ length: Math.min(selection.jobs, files.length) }, async () => {
			while (nextFile < files.length) {
				const index = nextFile++;
				const file = files[index];
				const countFile = resolve(resultDirectory, `${index}.txt`);
				const args = [
					'--import', './test/unit/ignore-css-imports.ts',
					'--import', './test/unit/theme-resources.ts',
					...(editorEnvironment ? ['--import', './test/unit/editor-environment.ts'] : []),
					'node_modules/mocha/bin/mocha.js',
					'--ui', 'tdd',
					'--reporter', './test/unit/reporter.ts',
					'--reporter-option', `countFile=${countFile}`,
					'--timeout', String(selection.timeout),
					...(selection.grep ? ['--grep', selection.grep] : []),
					file,
				];
				const status = await new Promise<number | null>((resolveExit, reject) => {
					// Each file retains its own process and globals. Buffer output per file
					// so concurrent assertion diagnostics remain readable in CI.
					const child = spawn(process.execPath, args, { cwd: desktopDirectory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
					child.stdout.setEncoding('utf8');
					child.stderr.setEncoding('utf8');
					let output = '';
					child.stdout.on('data', data => { output += data; });
					child.stderr.on('data', data => { output += data; });
					child.once('error', reject);
					child.once('close', code => {
						process.stdout.write(output);
						resolveExit(code);
					});
				});
				if (status !== 0) failed.push(file);
				if (existsSync(countFile)) executedTests += Number(readFileSync(countFile, 'utf8'));
			}
		});
		// Reap every worker before deleting the result directory, including spawn failures.
		const results = await Promise.allSettled(workers);
		const rejected = results.find(result => result.status === 'rejected');
		if (rejected?.status === 'rejected') throw rejected.reason;
	} finally {
		rmSync(resultDirectory, { recursive: true, force: true });
	}

	process.stdout.write(`Mocha: ${executedTests} tests executed across ${files.length} files; ${failed.length} failed files\n`);
	if (failed.length > 0) {
		process.stderr.write(`Failed test files:\n${failed.join('\n')}\n`);
		process.exitCode = 1;
	}
	if (executedTests === 0) {
		process.stderr.write('No unit tests executed; check the file selection and --grep pattern.\n');
		process.exitCode = 1;
	}
}

function sourceFile(value: string): string {
	if (!value.startsWith('src/') && !value.startsWith('test/')) {
		throw new Error(`--run expects a path relative to the repository root: ${value}`);
	}
	return value.endsWith('.ts') ? `${value.slice(0, -3)}.js` : value;
}

function parseSelection(args: readonly string[]): Selection {
	const runs: string[] = [];
	let runGlob: string | undefined;
	let grep: string | undefined;
	let timeout = 60_000;
	let jobs = 1;
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
			case '--jobs': {
				jobs = Number(value);
				if (!Number.isSafeInteger(jobs) || jobs <= 0) throw new Error(`Invalid test jobs: ${value}`);
				break;
			}
			default: throw new Error(`Unsupported unit test option: ${option}`);
		}
		index += 1;
	}
	if (runs.length > 0 && runGlob) throw new Error('--run and --runGlob cannot be combined');
	return { runs, runGlob, grep, timeout, jobs };
}
