import { execFileSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceExtensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const excludedDirectories = /(?:^|\/)(?:node_modules|generated|vendor|dist|out|fixtures|test-data|testData|typings)(?:\/|$)/;
const sourceRoots = ['src/', 'build/', 'extensions/', 'test/', 'services/', 'sdk/typescript/', 'examples/extensions/', 'crates/external-js-ext/', 'resources/extension-host/'];
const copiedSourceRoots = ['src/ash/base/browser/dompurify/', 'src/ash/base/common/marked/'];

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

function main(args: readonly string[]): number {
	const [mode, ...remaining] = args;
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
	const bun = resolve(repositoryRoot, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
	// Keep Git's exact source ownership while formatting batches natively in Bun.
	// Leave room for the environment and quoting under each platform's argument limit.
	const limit = process.platform === 'win32' ? 6000 : 120_000;
	const batches: string[][] = [];
	let batch: string[] = [];
	let length = 0;
	for (const file of files) {
		const absolutePath = resolve(contentRoot, file);
		const size = Buffer.byteLength(absolutePath, 'utf8') + 3;
		if (batch.length && length + size > limit) {
			batches.push(batch);
			batch = [];
			length = 0;
		}
		batch.push(absolutePath);
		length += size;
	}
	if (batch.length) batches.push(batch);
	let status = 0;
	for (const paths of batches) {
		const result = spawnSync(
			bun,
			[
				'fmt',
				'--no-script',
				'--disable-nested-config',
				'--config',
				resolve(contentRoot, '.prettierrc.toml'),
				'--ignore-path',
				resolve(contentRoot, '.gitignore'),
				'--ignore-path',
				resolve(contentRoot, '.prettierignore'),
				mode,
				'--log-level',
				'warn',
				'--',
				...paths,
			],
			{ cwd: contentRoot, stdio: 'inherit', windowsHide: true },
		);
		if (result.error) throw result.error;
		if (result.signal) throw new Error(`Bun formatter interrupted by ${result.signal}.`);
		status = Math.max(status, result.status ?? 1);
	}
	console.log(`Bun: ${mode === '--check' ? 'checked' : 'formatted'} ${files.length} TypeScript/JavaScript files.`);
	return status;
}

if (import.meta.main) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
