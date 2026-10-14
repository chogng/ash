import { withProcessRun } from '../../build/processes.ts';
import { copyFileSync, cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

interface Selection {
	readonly runs: readonly string[];
	readonly runGlob?: string;
	readonly grep?: string;
	readonly timeout: number;
}

const desktopDirectory = resolve(import.meta.dirname, '../..');
const compiledDirectory = resolve(process.env.ASH_UNIT_TEST_OUTPUT_DIRECTORY ?? resolve(desktopDirectory, '.build/desktop/test'));

export async function runUnitTests(patterns: readonly string[], editorEnvironment: boolean): Promise<void> {
	const requiredVersion = readFileSync(resolve(desktopDirectory, '.nvmrc'), 'utf8').trim();
	if (process.versions.node.split('.')[0] !== requiredVersion.split('.')[0]) {
		throw new Error(`Unit tests require the Node major version specified in .nvmrc (${requiredVersion}); found ${process.version}.`);
	}
	// Reject invalid filters before creating a snapshot of the complete compiler output.
	const selection = parseSelection(process.argv.slice(process.argv[2] === '--' ? 3 : 2));
	// Keep this run's modules alive when another invocation cleans the compiler output.
	const outputDirectory = mkdtempSync(resolve(desktopDirectory, '.build/desktop/test-run-'));
	try {
		cpSync(compiledDirectory, outputDirectory, { recursive: true });
		// TypeScript resolves vendored declarations but does not emit their adjacent JavaScript implementations.
		for (const path of ['src/ash/base/common/marked/marked.js', 'src/ash/base/browser/dompurify/dompurify.js']) {
			const output = resolve(outputDirectory, path);
			mkdirSync(dirname(output), { recursive: true });
			copyFileSync(resolve(desktopDirectory, path), output);
		}
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
			await withProcessRun(desktopDirectory, async (run, environment) => {
				for (const [index, file] of files.entries()) {
					if (!file.startsWith(`${outputDirectory}${sep}`) || !existsSync(file)) {
						throw new Error(`Compiled unit test does not exist: ${file}`);
					}
					const countFile = resolve(resultDirectory, `${index}.txt`);
					const result = await run.command(process.execPath, [
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
					], { ...environment, ASH_UNIT_TEST_OUTPUT_DIRECTORY: outputDirectory });
					if (run.stopped || result.code === 130 || result.code === 143) {
						process.exitCode = result.code;
						return;
					}
					if (result.code !== 0) failed.push(file);
					if (existsSync(countFile)) executedTests += Number(readFileSync(countFile, 'utf8'));
				}
			});
		} finally {
			rmSync(resultDirectory, { recursive: true, force: true });
		}

		if (process.exitCode === 130 || process.exitCode === 143) return;
		process.stdout.write(`Mocha: ${executedTests} tests executed across ${files.length} files; ${failed.length} failed files\n`);
		if (failed.length > 0) {
			process.stderr.write(`Failed test files:\n${failed.join('\n')}\n`);
			process.exitCode = 1;
		}
		if (executedTests === 0) {
			process.stderr.write('No unit tests executed; check the file selection and --grep pattern.\n');
			process.exitCode = 1;
		}
	} finally {
		rmSync(outputDirectory, { recursive: true, force: true });
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
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		const value = args[index + 1];
		if (!value) throw new Error(`Missing value for ${option}`);
		switch (option) {
			case '--run': runs.push(value); break;
			case '--runGlob': runGlob = value; break;
			case '--grep': {
				if (!value.trim() || value.startsWith('--')) throw new Error('--grep requires a nonempty pattern.');
				grep = value;
				break;
			}
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
