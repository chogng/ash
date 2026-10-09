import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { sourceFiles, sourceNames } from './format.ts';

interface ImportCaseIssue {
	readonly file: string;
	readonly line: number;
	readonly message: string;
	readonly fixed: boolean;
}

/** Checks Git's path spelling independently of the host filesystem's casing rules. */
export function checkImportCase(root: string, sources: readonly string[], inventory: readonly string[], fix = false, readSource: (file: string) => string = file => readFileSync(resolve(root, file), 'utf8')): ImportCaseIssue[] {
	const paths = new Map<string, string[]>();
	for (const name of inventory) {
		const absolute = resolve(root, name);
		const key = absolute.toLowerCase();
		paths.set(key, [...(paths.get(key) ?? []), absolute]);
	}
	const issues: ImportCaseIssue[] = [];
	for (const file of sources) {
		const absolute = resolve(root, file);
		let text = readSource(file);
		const edits: { start: number; end: number; value: string; }[] = [];
		for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
			const name = imported.fileName;
			if (!name.startsWith('./') && !name.startsWith('../')) { continue; }
			const requested = resolve(dirname(absolute), name);
			const replacements = name.endsWith('.js') ? ['.ts', '.tsx', '.d.ts', '.js', '.jsx']
				: name.endsWith('.mjs') ? ['.mts', '.d.mts', '.mjs']
					: name.endsWith('.cjs') ? ['.cts', '.d.cts', '.cjs'] : [];
			const extension = replacements.length ? name.slice(name.lastIndexOf('.')) : '';
			const candidates = replacements.length
				? replacements.map(suffix => ({ path: requested.slice(0, -extension.length) + suffix, suffix, replacement: extension }))
				: [{ path: requested, suffix: '', replacement: '' }, ...['.ts', '.tsx', '.d.ts', '.js', '/index.ts', '/index.js'].map(suffix => ({ path: resolve(requested + suffix), suffix, replacement: '' }))];
			for (const candidate of candidates) {
				const matches = paths.get(candidate.path.toLowerCase());
				if (!matches) { continue; }
				const line = text.slice(0, imported.pos).split('\n').length;
				if (matches.length !== 1) {
					issues.push({ file, line, message: `Ambiguous import ${name}: ${matches.map(path => relative(root, path)).join(', ')}`, fixed: false });
					break;
				}
				const target = matches[0]!.slice(0, candidate.suffix ? -candidate.suffix.length : undefined) + candidate.replacement;
				let expected = relative(dirname(absolute), target).replaceAll('\\', '/');
				if (!expected.startsWith('.')) { expected = './' + expected; }
				if (candidate.path !== matches[0]) {
					// Preprocessing offsets include the opening quote. Escaped literals
					// need human review rather than editing offsets in decoded text.
					const start = imported.pos + 1;
					const end = imported.end + 1;
					const fixed = fix && text.slice(start, end) === name;
					issues.push({ file, line, message: `${name} must be ${expected}`, fixed });
					if (fixed) { edits.push({ start, end, value: expected }); }
				}
				break;
			}
		}
		// Apply edits backwards so one corrected import cannot shift another.
		for (const edit of edits.sort((left, right) => right.start - left.start)) {
			text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
		}
		if (edits.length) { writeFileSync(absolute, text, 'utf8'); }
	}
	return issues;
}

/** Validates the staged index or a commit, even when unstaged repairs exist. */
export function checkGitImportCase(root: string, revision?: string): ImportCaseIssue[] {
	const inventory = execFileSync('git', revision ? ['ls-tree', '-r', '--name-only', '-z', revision] : ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
	const sources = sourceNames(inventory);
	const contents = new Map<string, string>();
	// One batch avoids starting a Git process for each of thousands of files.
	const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: sources.map(file => `${revision ?? ''}:${file}\n`).join(''), maxBuffer: 128 * 1024 * 1024 });
	let offset = 0;
	for (const file of sources) {
		const end = blobs.indexOf(10, offset);
		const match = /^[0-9a-f]+ blob (\d+)$/.exec(blobs.toString('utf8', offset, end));
		if (!match) { throw new Error(`Cannot read Git source ${file}`); }
		const size = Number(match[1]);
		contents.set(file, blobs.toString('utf8', end + 1, end + 1 + size));
		offset = end + 2 + size;
	}
	return checkImportCase(root, sources, inventory, false, file => contents.get(file)!);
}

if (import.meta.main) {
	try {
		const [mode, ...paths] = process.argv.slice(2);
		if (mode !== '--check' && mode !== '--fix') { throw new Error('Usage: node build/importCase.ts --check|--fix [file|directory ...]'); }
		const root = resolve(import.meta.dirname, '..');
		const inventory = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
		const snapshot = paths[0] === '--staged' || paths[0] === '--revision';
		if (snapshot && (mode === '--fix' || (paths[0] === '--staged' ? paths.length !== 1 : paths.length !== 2))) { throw new Error('Git snapshots require --check --staged or --check --revision <commit>'); }
		const sources = snapshot ? [] : sourceFiles(paths);
		const issues = snapshot ? checkGitImportCase(root, paths[0] === '--revision' ? paths[1] : undefined) : checkImportCase(root, sources, inventory, mode === '--fix');
		for (const issue of issues) { console.error(`${issue.file}:${issue.line}: ${issue.message}${issue.fixed ? ' (fixed)' : ''}`); }
		console.log(`${snapshot ? 'Git snapshot import paths' : `Import paths: checked ${sources.length} files`}; ${issues.filter(issue => !issue.fixed).length} errors; ${issues.filter(issue => issue.fixed).length} fixed.`);
		process.exitCode = issues.some(issue => !issue.fixed) ? 1 : 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
