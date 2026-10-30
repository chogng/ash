import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import ts from 'typescript';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceExtensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const excludedDirectories = /(?:^|\/)(?:node_modules|generated|vendor|dist|out|fixtures|test-data|testData|typings)(?:\/|$)/;
const sourceRoots = [
	'src/',
	'build/',
	'extensions/',
	'test/',
	'services/',
	'sdk/typescript/',
	'examples/extensions/',
	'crates/external-js-ext/',
	'resources/extension-host/',
];
const copiedSourceRoots = ['src/ash/base/browser/dompurify/', 'src/ash/base/common/marked/'];

/** Normalize whitespace without reflowing the author's statements, expressions, or comments. */
export function format(
	fileName: string,
	text: string,
	options: ts.FormatCodeSettings = JSON.parse(readFileSync(resolve(repositoryRoot, 'tsfmt.json'), 'utf8')),
): string {
	const absolutePath = resolve(fileName).replaceAll('\\', '/');
	const snapshot = ts.ScriptSnapshot.fromString(text);
	const service = ts.createLanguageService({
		getCompilationSettings: () => ({ allowJs: true }),
		getScriptFileNames: () => [absolutePath],
		getScriptVersion: () => '0',
		getScriptSnapshot: name => name === absolutePath ? snapshot : undefined,
		getCurrentDirectory: () => repositoryRoot,
		getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
		fileExists: name => name === absolutePath,
		readFile: name => name === absolutePath ? text : undefined,
	});
	try {
		// Apply replacements before insertions at the same offset so an inserted semicolon cannot be erased.
		const edits = service.getFormattingEditsForDocument(absolutePath, options)
			.sort((left, right) => right.span.start - left.span.start || right.span.length - left.span.length);
		if (edits.length === 0) {
			return text;
		}
		// Collect unchanged spans once instead of copying the entire document for every edit.
		const pieces: string[] = [];
		let end = text.length;
		for (const edit of edits) {
			pieces.push(text.slice(edit.span.start + edit.span.length, end), edit.newText);
			end = edit.span.start;
		}
		pieces.push(text.slice(0, end));
		return pieces.reverse().join('');
	} finally {
		service.dispose();
	}
}

function sourceFiles(paths: readonly string[], contentRoot: string): string[] {
	const selections = paths.map(path => {
		const name = relative(repositoryRoot, resolve(repositoryRoot, path));
		if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
			throw new Error(`Source path must belong to the repository: ${path}`);
		}
		return { path, name: name.replaceAll('\\', '/') };
	});
	// Git owns the input inventory so ignored build outputs cannot become sources.
	// Literal pathspecs preserve filenames containing glob characters, such as brackets.
	const scope = selections.length ? selections.map(({ name }) => name || '.') : sourceRoots;
	const inventory = execFileSync('git', ['--literal-pathspecs', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scope], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	}).split('\0');
	const files = [...new Set(inventory)]
		.filter(
			name =>
				sourceRoots.some(root => name.startsWith(root)) &&
				!copiedSourceRoots.some(root => name.startsWith(root)) &&
				sourceExtensions.test(name) &&
				!/\.d\.[cm]?ts$/.test(name) &&
				!excludedDirectories.test(name),
		)
		.sort();
	// Narrow requested paths before touching the filesystem; Git may still list deleted files.
	const isFile = (name: string): boolean => statSync(resolve(contentRoot, name), { throwIfNoEntry: false })?.isFile() === true;
	if (paths.length === 0) {
		return files.filter(isFile);
	}
	const selected = new Set<string>();
	for (const { path, name } of selections) {
		const matches = files.filter(file => name === '' || file === name || file.startsWith(`${name}/`)).filter(isFile);
		if (matches.length === 0) {
			throw new Error(`No first-party TypeScript or JavaScript sources matched: ${path}`);
		}
		for (const file of matches) {
			selected.add(file);
		}
	}
	return [...selected].sort();
}

interface FormattingJob {
	files: readonly string[];
	contentRoot: string;
	mode: '--check' | '--write';
	options: ts.FormatCodeSettings;
}

function formatFiles({ files, contentRoot, mode, options }: FormattingJob): string[] {
	const changed: string[] = [];
	for (const file of files) {
		const absolutePath = resolve(contentRoot, file);
		const original = readFileSync(absolutePath, 'utf8');
		const formatted = format(absolutePath, original, options);
		if (formatted !== original) {
			changed.push(file);
			if (mode === '--write') {
				writeFileSync(absolutePath, formatted, 'utf8');
			}
		}
	}
	return changed;
}

async function formatBatch(job: FormattingJob): Promise<string[]> {
	// Amortize loading TypeScript in each worker; editor buffers and small checks stay in-process.
	const count = Math.min(4, availableParallelism(), Math.floor(job.files.length / 250));
	if (count < 2) {
		return formatFiles(job);
	}
	const batches = Array.from({ length: count }, () => [] as string[]);
	job.files.forEach((file, index) => batches[index % count].push(file));
	const workers: Worker[] = [];
	try {
		const results = await Promise.all(
			batches.map(files => new Promise<string[]>((resolve, reject) => {
				const worker = new Worker(new URL(import.meta.url), {
					workerData: {
						...job,
						files,
						formatter: import.meta.url,
					},
				});
				workers.push(worker);
				worker.once('message', (changed: unknown) => {
					if (
						!Array.isArray(changed) ||
						!changed.every(file => typeof file === 'string' && files.includes(file))
					) {
						reject(new Error('Invalid TypeScript formatter worker result.'));
						return;
					}
					resolve(changed);
				});
				worker.once('error', reject);
				worker.once('exit', code => {
					reject(new Error(`TypeScript formatter worker exited before returning results (code ${code}).`));
				});
			})),
		);
		return results.flat();
	} finally {
		// Stop remaining work on failure and release each worker's compiler and syntax tree.
		await Promise.all(workers.map(worker => worker.terminate()));
	}
}

async function main(args: readonly string[]): Promise<number> {
	const [mode, ...remaining] = args;
	if (mode === '--stdin-filepath') {
		if (remaining.length !== 1 || !remaining[0]) {
			throw new Error('--stdin-filepath requires one source path.');
		}
		const name = relative(repositoryRoot, resolve(remaining[0])).replaceAll('\\', '/');
		if (name === '..' || name.startsWith('../') || isAbsolute(name) || !sourceExtensions.test(name)) {
			throw new Error(`Unsupported source path: ${remaining[0]}`);
		}
		const input = readFileSync(0, 'utf8');
		const ignored = spawnSync('git', [
			'-c', `core.excludesFile=${resolve(repositoryRoot, '.prettierignore')}`,
			'check-ignore', '--no-index', '--quiet', '--', name,
		], { cwd: repositoryRoot, encoding: 'utf8' });
		if (ignored.error) {
			throw ignored.error;
		}
		if (ignored.status !== 0 && ignored.status !== 1) {
			throw new Error(ignored.stderr || 'Cannot resolve source ignore rules.');
		}
		const preserve = ignored.status === 0
			|| excludedDirectories.test(name)
			|| copiedSourceRoots.some(root => name.startsWith(root))
			|| /\.d\.[cm]?ts$/.test(name);
		process.stdout.write(preserve ? input : format(remaining[0], input));
		return 0;
	}
	// The repository orchestrator supplies a sparse snapshot for scoped checks and
	// writes. Git still owns source selection; only file contents and settings move.
	const snapshot = remaining[0] === '--content-root';
	if (snapshot && (!remaining[1] || !isAbsolute(remaining[1]))) {
		throw new Error('--content-root requires an absolute snapshot directory.');
	}
	const contentRoot = snapshot ? remaining[1] : repositoryRoot;
	const paths = snapshot ? remaining.slice(2) : remaining;
	if ((mode !== '--check' && mode !== '--write') || paths.some(path => path.startsWith('-'))) {
		throw new Error('Usage: pnpm format:ts[:fix] [file|directory ...]');
	}
	const files = sourceFiles(paths, contentRoot);
	if (files.length === 0 && !snapshot) {
		throw new Error('No first-party TypeScript or JavaScript sources found.');
	}
	const options: ts.FormatCodeSettings = JSON.parse(readFileSync(resolve(contentRoot, 'tsfmt.json'), 'utf8'));
	const changed = await formatBatch({ files, contentRoot, mode, options });
	if (mode === '--check') {
		for (const file of changed.sort()) {
			console.error(`File not formatted: ${file}`);
		}
	}
	console.log(`TypeScript: ${mode === '--check' ? 'checked' : 'formatted'} ${files.length} TypeScript/JavaScript files; ${changed.length} changed.`);
	return mode === '--check' && changed.length > 0 ? 1 : 0;
}

// Bun workers do not set import.meta.main. The module identity also keeps imports
// from unrelated build workers from accidentally starting a formatter job.
if (!isMainThread && workerData?.formatter === import.meta.url) {
	parentPort!.postMessage(formatFiles(workerData as FormattingJob));
} else if (import.meta.main) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
