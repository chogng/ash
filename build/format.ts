import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
		for (const edit of edits) {
			text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
		}
		return text;
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

function main(args: readonly string[]): number {
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
	let changes = 0;
	for (const file of files) {
		const absolutePath = resolve(contentRoot, file);
		const original = readFileSync(absolutePath, 'utf8');
		const formatted = format(absolutePath, original, options);
		if (formatted !== original) {
			changes++;
			if (mode === '--check') {
				console.error(`File not formatted: ${file}`);
			} else {
				writeFileSync(absolutePath, formatted, 'utf8');
			}
		}
	}
	console.log(`TypeScript: ${mode === '--check' ? 'checked' : 'formatted'} ${files.length} TypeScript/JavaScript files; ${changes} changed.`);
	return mode === '--check' && changes > 0 ? 1 : 0;
}

if (import.meta.main) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
