import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRun } from '../../build/processes.ts';

const root = resolve(import.meta.dirname, '../..');
const formats = new Set(['html', 'lcov', 'lcovonly', 'json', 'json-summary', 'text', 'text-summary']);

export interface CoverageOptions {
	readonly coverage: boolean;
	readonly coveragePath?: string;
	readonly coverageFormats: readonly string[];
}

/** Validate report options before preparation or output creation. */
export function validateCoverageOptions(options: CoverageOptions): void {
	if (!options.coverage && (options.coveragePath || options.coverageFormats.length)) {
		throw new Error('--coveragePath and --coverageFormats require --coverage');
	}
	if (options.coveragePath !== undefined) {
		if (!options.coveragePath.trim() || options.coveragePath.startsWith('--')) throw new Error('--coveragePath requires a nonempty directory');
		if (existsSync(resolve(root, options.coveragePath))) throw new Error(`Coverage directory already exists: ${options.coveragePath}`);
	}
	for (const format of options.coverageFormats) {
		if (!formats.has(format)) throw new Error(`Unsupported coverage format: ${format}`);
	}
}

/** Own raw data until Node and Chromium have both finished, then remap them to source. */
export class UnitCoverage {
	readonly directory: string;
	readonly environment: NodeJS.ProcessEnv;
	private readonly raw: string;
	private readonly options: CoverageOptions;

	constructor(options: CoverageOptions) {
		this.options = options;
		if (options.coveragePath) {
			this.directory = resolve(root, options.coveragePath);
			// Never erase an earlier result or a directory supplied by the caller.
			mkdirSync(this.directory, { recursive: false });
		} else {
			const parent = resolve(root, '.build/coverage');
			mkdirSync(parent, { recursive: true });
			this.directory = mkdtempSync(resolve(parent, 'frontend-'));
		}
		this.raw = resolve(this.directory, 'raw');
		mkdirSync(this.raw);
		this.environment = { NODE_V8_COVERAGE: this.raw, NODE_DISABLE_COMPILE_CACHE: '1', ASH_UNIT_COVERAGE_DIRECTORY: this.raw };
		writeFileSync(resolve(this.directory, 'run.json'), JSON.stringify({ status: 'incomplete', command: process.argv.slice(1) }, null, 2) + '\n');
	}

	async report(run: ProcessRun, environment: NodeJS.ProcessEnv, snapshot: string, assets: string | undefined, result: { files: readonly string[]; failed: readonly string[]; executedTests: number; completed: boolean; }): Promise<void> {
		if (run.stopped) {
			writeFileSync(resolve(this.directory, 'run.json'), JSON.stringify({ ...result, status: 'interrupted' }, null, 2) + '\n');
			return;
		}
		const input = resolve(this.directory, 'input');
		mkdirSync(input);
		let nodeScripts = 0;
		let browserScripts = 0;
		for (const name of readdirSync(this.raw)) {
			if (!name.endsWith('.json')) continue;
			const data = JSON.parse(readFileSync(resolve(this.raw, name), 'utf8'));
			if (!Array.isArray(data.result)) throw new Error(`Invalid V8 coverage file: ${name}`);
			data.result = data.result.filter((script: { url: string; }) => {
				if (typeof script.url !== 'string' || !script.url.startsWith('file:')) return false;
				const path = fileURLToPath(script.url);
				if (assets && inside(assets, path)) { browserScripts++; return true; }
				if (inside(resolve(snapshot, 'src/ash'), path) || inside(resolve(snapshot, 'extensions'), path)) { nodeScripts++; return true; }
				return false;
			});
			// Dependency sources can dominate multi-process V8 dumps. Keep only the
			// selected scripts and their cached source maps before c8 merges counts.
			if (data['source-map-cache']) {
				const urls = new Set(data.result.map((script: { url: string; }) => script.url));
				data['source-map-cache'] = Object.fromEntries(Object.entries(data['source-map-cache']).filter(([url]) => urls.has(url)));
			}
			if (data.result.length) writeFileSync(resolve(input, name), JSON.stringify(data));
		}
		const metadata = {
			...result, files: result.files.map(path => relative(snapshot, path)), failed: result.failed.map(path => relative(snapshot, path)),
			status: !result.completed ? 'incomplete' : result.failed.length || result.executedTests === 0 ? 'failed' : 'passed',
			reportStatus: 'incomplete', command: process.argv.slice(1), platform: process.platform,
			nodeScripts, browserScripts,
			scope: 'Frontend TypeScript in src/ash and extensions; Node and helper-owned Chromium pages; excludes tests, fixtures, declarations, dependencies and generated protocol files. Unloaded source files are included. Rust is reported separately.',
		};
		writeFileSync(resolve(this.directory, 'run.json'), JSON.stringify(metadata, null, 2) + '\n');
		if (nodeScripts + browserScripts === 0) throw new Error('No frontend V8 coverage was collected');
		const reporters = new Set(this.options.coverageFormats.length ? this.options.coverageFormats : ['text-summary', 'html', 'lcov', 'json']);
		reporters.add('json-summary');
		const report = await run.command(process.execPath, [
			'node_modules/c8/bin/c8.js', 'report', '--temp-directory', input, '--reports-dir', this.directory,
			'--all', '--src', 'src/ash', '--src', 'extensions', '--extension', '.ts', '--extension', '.js',
			'--include', 'src/ash/**/*.ts', '--include', 'extensions/**/*.ts', '--exclude-after-remap', '--merge-async',
			'--exclude', '**/test/**', '--exclude', '**/tests/**', '--exclude', '**/fixtures/**', '--exclude', '**/*.test.ts',
			'--exclude', '**/*.d.ts', '--exclude', '**/node_modules/**', '--exclude', 'src/ash/protocol/**',
			...[...reporters].flatMap(format => ['--reporter', format]),
		], environment);
		metadata.reportStatus = report.code === 0 ? 'complete' : 'failed';
		writeFileSync(resolve(this.directory, 'run.json'), JSON.stringify(metadata, null, 2) + '\n');
		if (report.code !== 0) throw new Error(`Coverage reporting failed (${report.code}); raw data: ${this.raw}`);
		process.stdout.write(`Frontend coverage (${metadata.status} test run): ${this.directory}\n`);
	}

	validateSourceMaps(snapshot: string): void {
		for (const file of globSync(['src/ash/**/*.js', 'extensions/**/*.js'], { cwd: snapshot })) {
			if (!existsSync(resolve(root, file.replace(/\.js$/u, '.ts')))) continue;
			if (!existsSync(resolve(snapshot, file + '.map'))) {
				throw new Error(`Coverage requires source maps; rerun the compiling test entry: ${file}`);
			}
		}
	}
}

function inside(parent: string, path: string): boolean {
	const child = relative(parent, path);
	return !!child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

/** c8 filters each mapped range before resolving relative multi-source map paths. */
export function normalizeCoverageSourceMaps(assets: string): void {
	for (const name of globSync('**/*.js.map', { cwd: assets })) {
		const path = resolve(assets, name);
		const map = JSON.parse(readFileSync(path, 'utf8'));
		map.sources = map.sources.map((source: string) => source.startsWith('file:') ? fileURLToPath(source) : resolve(dirname(path), map.sourceRoot ?? '', source));
		delete map.sourceRoot;
		writeFileSync(path, JSON.stringify(map));
	}
}
