import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const repositoryRoot = resolve(import.meta.dirname, '..');
const settings: ts.FormatCodeSettings = JSON.parse(readFileSync(resolve(repositoryRoot, 'tsfmt.json'), 'utf8'));
const sourceExtensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const excludedDirectories = /(?:^|\/)(?:node_modules|generated|vendor|dist|out|fixtures|test-data|testData|typings)(?:\/|$)/;
const sourceRoots = ['src/', 'build/', 'extensions/', 'test/', 'services/', 'crates/js-extension-host/'];
const copiedSourceRoots = ['src/ash/base/browser/dompurify/', 'src/ash/base/common/marked/'];
const generatedSources = new Set(['src/ash/base/common/productIcons.ts']);

export function format(fileName: string, text: string): string {
	const absolutePath = resolve(fileName);
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
		// At the same offset, replace whitespace before inserting a semicolon so the replacement cannot erase it.
		const edits = service.getFormattingEditsForDocument(absolutePath, settings).sort((left, right) => right.span.start - left.span.start || right.span.length - left.span.length);
		for (const edit of edits) {
			text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
		}
		return text;
	} finally {
		service.dispose();
	}
}

export function verifyFormatting(fileName: string, text: string): boolean {
	return format(fileName, text) === text;
}

export function sourceFiles(paths: readonly string[]): string[] {
	// Git owns the input inventory so ignored build outputs cannot become sources.
	const inventory = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0');
	const files = sourceNames(inventory).filter(name => statSync(resolve(repositoryRoot, name), { throwIfNoEntry: false })?.isFile());
	if (paths.length === 0) {
		return files;
	}
	const selected = new Set<string>();
	for (const path of paths) {
		const name = relative(repositoryRoot, resolve(repositoryRoot, path));
		if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
			throw new Error(`Source path must belong to the repository: ${path}`);
		}
		const normalized = name.replaceAll('\\', '/');
		const matches = files.filter(file => normalized === '' || file === normalized || file.startsWith(`${normalized}/`));
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
	const [mode, ...paths] = args;
	if ((mode !== '--check' && mode !== '--write') || paths.some(path => path.startsWith('-'))) {
		throw new Error('Usage: pnpm format:ts[:fix] [file|directory ...]');
	}
	const files = sourceFiles(paths);
	if (files.length === 0) {
		throw new Error('No first-party TypeScript or JavaScript sources found.');
	}
	let changes = 0;
	for (const file of files) {
		const absolutePath = resolve(repositoryRoot, file);
		const text = readFileSync(absolutePath, 'utf8');
		if (mode === '--check') {
			if (!verifyFormatting(absolutePath, text)) {
				changes++;
				console.error(`File not formatted: ${file}`);
			}
		} else {
			const formatted = format(absolutePath, text);
			if (formatted !== text) {
				changes++;
				writeFileSync(absolutePath, formatted, 'utf8');
			}
		}
	}
	console.log(`TypeScript/JavaScript: checked ${files.length} files; ${changes} ${mode === '--check' ? 'unformatted' : 'formatted'}.`);
	return mode === '--check' && changes > 0 ? 1 : 0;
}

/** Selects owned sources without consulting a possibly different working tree. */
export function sourceNames(inventory: readonly string[]): string[] {
	return [...new Set(inventory)].filter(name => sourceRoots.some(root => name.startsWith(root)) && !copiedSourceRoots.some(root => name.startsWith(root)) && !generatedSources.has(name) && sourceExtensions.test(name) && !/\.d\.[cm]?ts$/.test(name) && !excludedDirectories.test(name)).sort();
}

if (import.meta.main) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
