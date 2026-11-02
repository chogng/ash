import { withProcessRun } from '../../build/processes.ts';
import { constants, copyFileSync, cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { startBrowserUnitServer } from './browser/server.ts';
import { planAffectedTests } from './impactWorker.ts';
import { UnitCoverage, validateCoverageOptions, type CoverageOptions } from './coverage.ts';

interface Selection extends CoverageOptions {
	readonly runs: readonly string[];
	readonly runGlob?: string;
	readonly affected?: string;
	readonly grep?: string;
	readonly timeout: number;
	readonly workers: number;
	readonly plan: boolean;
}

const desktopDirectory = resolve(import.meta.dirname, '../..');
const compiledDirectory = resolve(process.env.ASH_UNIT_TEST_OUTPUT_DIRECTORY ?? resolve(desktopDirectory, '.build/desktop/test'));

export async function runUnitTests(patterns: readonly string[], editorEnvironment: boolean, project = 'tsconfig.test.json'): Promise<void> {
	const requiredVersion = readFileSync(resolve(desktopDirectory, '.nvmrc'), 'utf8').trim();
	if (process.versions.node.split('.')[0] !== requiredVersion.split('.')[0]) {
		throw new Error(`Unit tests require the Node major version specified in .nvmrc (${requiredVersion}); found ${process.version}.`);
	}
	const args = process.argv.slice(2);
	// Package scripts choose preparation; the same runner owns selection in every mode.
	const preparation = args[0] === '--compile' || args[0] === '--prepared' ? args.shift() : undefined;
	if (args[0] === '--') args.shift();
	const selection = parseSelection(args);
	const preloads = ['test/unit/ignore-css-imports.ts', 'test/unit/theme-resources.ts', ...(editorEnvironment ? ['test/unit/editor-environment.ts'] : [])];
	// Plans and compiling runs discover source tests, so they work on a cold checkout
	// and cannot accidentally select stale output left by a deleted test.
	const discoveryDirectory = preparation || selection.plan ? desktopDirectory : compiledDirectory;
	const discover = (pattern: string): string[] => {
		const sourcePattern = discoveryDirectory === desktopDirectory ? pattern.replace(/\.js$/u, '.ts') : pattern;
		return globSync(sourcePattern, { cwd: discoveryDirectory, exclude: ['**/node_modules/**', '.git/**', '.build/**'] })
			.map(path => path.replaceAll('\\', '/'))
			.filter(path => /^(?:src|test|extensions)\//u.test(path))
			.map(sourceFile);
	};
	let names: string[];
	if (selection.runs.length > 0) {
		names = selection.runs.map(sourceFile);
	} else if (selection.runGlob) {
		names = discover(selection.runGlob);
	} else {
		names = patterns.flatMap(pattern => {
			const matches = discover(pattern);
			if (matches.length === 0) throw new Error(`No ${discoveryDirectory === desktopDirectory ? 'source' : 'compiled'} unit tests matched the required pattern: ${pattern}`);
			return matches;
		});
	}
	names = [...new Set(names)].sort();
	if (names.length === 0) throw new Error('No unit tests matched the requested files');
	if (discoveryDirectory === desktopDirectory) {
		for (const name of names) {
			if (!existsSync(resolve(desktopDirectory, name.replace(/\.js$/u, '.ts')))) throw new Error(`Source unit test does not exist: ${name}`);
		}
	}
	if (selection.affected) {
		const plan = planAffectedTests(desktopDirectory, selection.affected, names, { preloads });
		process.stdout.write(`Unit test impact: ${plan.full ? 'full suite' : 'selected files'}; ${plan.reason}\n`);
		names = [...plan.files];
	}
	if (selection.plan) {
		process.stdout.write(`Unit test plan: ${names.length} files${selection.grep ? `; grep: ${selection.grep}` : ''}; no preparation, compilation or tests executed\n`);
		for (const name of names) process.stdout.write(`${name}\n`);
		return;
	}
	if (names.length === 0) {
		process.stdout.write('Unit tests skipped: no affected test files; no tests executed.\n');
		return;
	}
	if (preparation) {
		await withProcessRun(desktopDirectory, async (run, environment) => {
			const commands = [
				...(preparation === '--compile' ? [
					['build/desktop/build.ts', 'prepare'],
					['build/prepare.ts'],
				] : []),
				['test/unit/prepare.ts', project],
				['node_modules/@ash/typescript-compiler/bin/tsc', '-p', project],
			];
			for (const command of commands) {
				const result = await run.command(process.execPath, command, environment);
				if (result.code !== 0) { process.exitCode = result.code; return; }
			}
		});
		if (process.exitCode) return;
	}
	// Keep this run's modules alive when another invocation cleans the compiler output.
	const outputDirectory = mkdtempSync(resolve(desktopDirectory, '.build/desktop/test-run-'));
	try {
		// Reflinks keep the snapshot independent of compiler writes without copying
		// every byte on filesystems that support them; elsewhere Node copies normally.
		cpSync(compiledDirectory, outputDirectory, { recursive: true, mode: constants.COPYFILE_FICLONE });
		// TypeScript resolves vendored declarations but does not emit their adjacent JavaScript implementations.
		for (const path of ['src/ash/base/common/marked/marked.js', 'src/ash/base/browser/dompurify/dompurify.js']) {
			const output = resolve(outputDirectory, path);
			mkdirSync(dirname(output), { recursive: true });
			copyFileSync(resolve(desktopDirectory, path), output);
		}
		const files = [...new Set(names.map(name => resolve(outputDirectory, name)))].sort();
		if (files.length === 0) {
			throw new Error('No compiled unit tests matched the requested files');
		}
		for (const file of files) {
			if (!file.startsWith(`${outputDirectory}${sep}`) || !existsSync(file)) {
				throw new Error(`Compiled unit test does not exist: ${file}`);
			}
		}

		const failed: string[] = [];
		let executedTests = 0;
		const coverage = selection.coverage ? new UnitCoverage(selection) : undefined;
		coverage?.validateSourceMaps(outputDirectory);
		const resultDirectory = mkdtempSync(resolve(tmpdir(), 'ash-unit-results-'));
		try {
			await withProcessRun(desktopDirectory, async (run, environment) => {
				const coverageEnvironment = { ...environment, ...coverage?.environment };
				const browserServer = files.some(file => /unit\/browser\/context\.js/u.test(readFileSync(file, 'utf8')))
					? await startBrowserUnitServer(run, coverageEnvironment) : undefined;
				// Reuse compiled bytecode across isolated processes, never their module
				// instances or globals. The first completed files warm subsequent workers;
				// the run owns cleanup, and V8 coverage keeps its uncached precision.
				// A single wave has no reuse to offset the cost of writing a cold cache.
				const testEnvironment = {
					...coverageEnvironment,
					NODE_COMPILE_CACHE: environment.NODE_COMPILE_CACHE ?? (files.length > selection.workers ? resolve(resultDirectory, 'compile-cache') : undefined),
					...(coverageEnvironment.NODE_V8_COVERAGE ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {}),
					...(browserServer ? { ASH_BROWSER_UNIT_BASE_URL: browserServer.url, ASH_BROWSER_UNIT_RESULTS: browserServer.results, ASH_UNIT_COVERAGE_ASSETS: browserServer.assets } : {}),
				};
				let completed = false;
				try {
					let nextFile = 0;
					const worker = async (): Promise<void> => {
						while (!run.stopped && nextFile < files.length) {
							const index = nextFile++;
							const file = files[index];
							const countFile = resolve(resultDirectory, `${index}.txt`);
							const result = await run.command(process.execPath, [
								...preloads.flatMap(path => ['--import', `./${path}`]),
								'node_modules/mocha/bin/mocha.js',
								'--ui', 'tdd',
								'--forbid-only',
								'--reporter', './test/unit/reporter.ts',
								'--reporter-option', `countFile=${countFile}`,
								'--timeout', String(selection.timeout),
								...(selection.grep ? ['--grep', selection.grep] : []),
								file,
							], { ...testEnvironment, ASH_UNIT_TEST_OUTPUT_DIRECTORY: outputDirectory }, true);
							// Print one completed file at a time so concurrent reporters stay readable.
							process.stdout.write(result.output);
							if (run.stopped || result.code === 130 || result.code === 143) {
								if (!run.stopped) {
									process.exitCode = result.code;
									await run.stop(result.code === 130 ? 'SIGINT' : 'SIGTERM');
								}
								return;
							}
							if (result.code !== 0) failed.push(file);
							if (existsSync(countFile)) executedTests += Number(readFileSync(countFile, 'utf8'));
						}
					};
					const results = await Promise.allSettled(Array.from({ length: Math.min(selection.workers, files.length) }, async () => {
						try { await worker(); }
						catch (error) { await run.close(); throw error; }
					}));
					for (const result of results) {
						if (result.status === 'rejected') throw result.reason;
					}
					completed = !run.stopped;
				} finally {
					try { await coverage?.report(run, environment, outputDirectory, browserServer?.assets, { files, failed, executedTests, completed }); }
					finally { await browserServer?.dispose(); }
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
	if ((!value.startsWith('src/') && !value.startsWith('test/') && !value.startsWith('extensions/')) || value.includes('\\') || value.split('/').includes('..')) {
		throw new Error(`--run expects a path relative to the repository root: ${value}`);
	}
	return value.endsWith('.ts') ? `${value.slice(0, -3)}.js` : value;
}

function parseSelection(args: readonly string[]): Selection {
	const runs: string[] = [];
	let runGlob: string | undefined;
	let affected: string | undefined;
	let grep: string | undefined;
	let timeout = 60_000;
	let workers = Math.min(4, availableParallelism());
	let plan = false;
	let coverage = false;
	let coveragePath: string | undefined;
	const coverageFormats: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === '--plan') { plan = true; continue; }
		if (option === '--coverage') { coverage = true; continue; }
		const value = args[index + 1];
		if (!value) throw new Error(`Missing value for ${option}`);
		switch (option) {
			case '--coveragePath': coveragePath = value; break;
			case '--coverageFormats': coverageFormats.push(...value.split(',')); break;
			case '--run': runs.push(value); break;
			case '--runGlob': runGlob = value; break;
			case '--affected': {
				if (affected || !value.trim() || value.startsWith('--')) throw new Error('--affected requires one base revision.');
				affected = value;
				break;
			}
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
			case '--workers': {
				workers = Number(value);
				if (!Number.isSafeInteger(workers) || workers <= 0) throw new Error(`Invalid worker count: ${value}`);
				break;
			}
			default: throw new Error(`Unsupported unit test option: ${option}`);
		}
		index += 1;
	}
	if (runs.length > 0 && runGlob) throw new Error('--run and --runGlob cannot be combined');
	if (affected && (runs.length > 0 || runGlob)) throw new Error('--affected cannot be combined with --run or --runGlob');
	const selection = { runs, runGlob, affected, grep, timeout, workers, plan, coverage, coveragePath, coverageFormats };
	validateCoverageOptions(selection);
	return selection;
}
