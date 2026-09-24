import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const localRoot = resolve(repositoryRoot, 'app-ts/src/ash/editor');
const upstreamRoot = resolve(repositoryRoot, '../vscode/src/vs/editor');
const sourceExtension = /\.(?:css|js|ts|tsx)$/u;
const upstreamBrand = /(?:\bmonaco-[a-z0-9_-]+\b|--vscode-[a-z0-9_-]+)/giu;
const upstreamProductRoot = /\bmonaco-editor\b/gu;
const gitOutputBuffer = 64 * 1024 * 1024;

export function normalizeCssBranding(source) {
	return stripMicrosoftLicenseHeader(source)
		.replaceAll('stanza-editor', 'monaco-editor')
		.replaceAll('--ash-', '--vscode-');
}

export function classifyCssPair(localSource, upstreamSource) {
	if (localSource === upstreamSource) return 'upstream-identical';
	if (normalizeCssBranding(localSource) === stripMicrosoftLicenseHeader(upstreamSource)) return 'upstream-equivalent after branding';
	return 'independent';
}

export function findUpstreamBrandLines(source, path) {
	const result = [];
	for (const [index, line] of source.split(/\r?\n/u).entries()) {
		const matches = [...line.matchAll(new RegExp(upstreamBrand.source, upstreamBrand.flags))];
		for (const match of matches) result.push({ path, line: index + 1, value: match[0] });
	}
	return result;
}

export function findAddedUpstreamBrandLines(diff) {
	const result = [];
	let path;
	let lineNumber = 0;
	for (const line of diff.split(/\r?\n/u)) {
		const fileMatch = /^\+\+\+ b\/(.+)$/u.exec(line);
		if (fileMatch) {
			path = sourceExtension.test(fileMatch[1]) ? fileMatch[1] : undefined;
			continue;
		}
		const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(line);
		if (hunkMatch) {
			lineNumber = Number(hunkMatch[1]);
			continue;
		}
		if (!path || line.startsWith('---')) continue;
		if (line.startsWith('+')) {
			result.push(...findUpstreamBrandLines(line.slice(1), path).map(match => ({ ...match, line: lineNumber })));
			lineNumber += 1;
		} else if (!line.startsWith('-') && !line.startsWith('\\')) {
			lineNumber += 1;
		}
	}
	return result;
}

export function findChangedPaths(diff) {
	return [...new Set(diff
		.split(/\r?\n/u)
		.map(line => /^\+\+\+ b\/(.+)$/u.exec(line)?.[1])
		.filter(path => path !== undefined))];
}

export function auditEditorCssOwnership(options = {}) {
	const resolvedRepositoryRoot = options.repositoryRoot ?? repositoryRoot;
	const resolvedLocalRoot = options.localRoot ?? resolve(resolvedRepositoryRoot, 'app-ts/src/ash/editor');
	const resolvedUpstreamRoot = options.upstreamRoot ?? resolve(resolvedRepositoryRoot, '../vscode/src/vs/editor');
	const productionFiles = readProductionFiles(resolvedLocalRoot);
	const cssFiles = productionFiles.filter(file => file.endsWith('.css'));
	const exactCopies = [];
	const brandingEquivalent = [];
	const brandReferences = [];
	const productRoots = [];

	for (const file of productionFiles) {
		const path = normalizePath(relative(resolvedLocalRoot, file));
		const source = readFileSync(file, 'utf8');
		const matches = findUpstreamBrandLines(source, path);
		brandReferences.push(...matches);
		for (const [index, line] of source.split(/\r?\n/u).entries()) {
			if (upstreamProductRoot.test(line)) productRoots.push({ path, line: index + 1, value: 'monaco-editor' });
			upstreamProductRoot.lastIndex = 0;
		}
		if (!file.endsWith('.css')) continue;
		const upstreamFile = resolve(resolvedUpstreamRoot, path);
		if (!existsSync(upstreamFile)) continue;
		const classification = classifyCssPair(source, readFileSync(upstreamFile, 'utf8'));
		if (classification === 'upstream-identical') exactCopies.push(path);
		else if (classification === 'upstream-equivalent after branding') brandingEquivalent.push(path);
	}

	const localScope = normalizePath(relative(resolvedRepositoryRoot, resolvedLocalRoot));
	const diff = options.diff ?? runGit(resolvedRepositoryRoot, ['diff', 'HEAD', '--unified=0', '--no-ext-diff', '--', localScope]);
	const untrackedFiles = options.untrackedFiles ?? readUntrackedProductionFiles(resolvedRepositoryRoot, resolvedLocalRoot);
	const introducedBrandReferences = findAddedUpstreamBrandLines(diff);
	for (const file of untrackedFiles) {
		const path = normalizePath(relative(resolvedRepositoryRoot, file));
		introducedBrandReferences.push(...findUpstreamBrandLines(readFileSync(file, 'utf8'), path));
	}
	const changedLocalPaths = new Set([
		...findChangedPaths(diff)
			.filter(path => path.startsWith(`${localScope}/`))
			.map(path => path.slice(localScope.length + 1)),
		...untrackedFiles.map(file => normalizePath(relative(resolvedLocalRoot, file))),
	]);
	const changedBrandingEquivalent = brandingEquivalent.filter(path => changedLocalPaths.has(path));

	return {
		cssFileCount: cssFiles.length,
		exactCopies,
		brandingEquivalent,
		brandReferences,
		productRoots,
		introducedBrandReferences,
		changedBrandingEquivalent,
	};
}

function readProductionFiles(root) {
	if (!existsSync(root)) return [];
	const result = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'test') result.push(...readProductionFiles(path));
		} else if (entry.isFile() && sourceExtension.test(entry.name)) {
			result.push(path);
		}
	}
	return result.sort();
}

function readUntrackedProductionFiles(resolvedRepositoryRoot, resolvedLocalRoot) {
	const output = runGit(resolvedRepositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', normalizePath(relative(resolvedRepositoryRoot, resolvedLocalRoot))]);
	return output
		.split(/\r?\n/u)
		.filter(line => line.startsWith('?? '))
		.map(line => resolve(resolvedRepositoryRoot, line.slice(3)))
		.filter(file => sourceExtension.test(file) && !normalizePath(relative(resolvedLocalRoot, file)).split('/').includes('test'));
}

function runGit(cwd, args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: gitOutputBuffer, shell: false });
	if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `git ${args.join(' ')} failed`);
	return result.stdout;
}

function normalizePath(value) {
	return value.split(sep).join('/');
}

function stripMicrosoftLicenseHeader(source) {
	return source.replace(
		/^\/\*[-]+\r?\n \*  Copyright \(c\) Microsoft Corporation\. All rights reserved\.\r?\n \*  Licensed under the MIT License\. See License\.txt in the project root for license information\.\r?\n \*[-]+\*\/\r?\n*/u,
		'',
	);
}

function printEntries(label, entries) {
	if (entries.length === 0) return;
	process.stdout.write(`${label}:\n`);
	for (const entry of entries) {
		if (typeof entry === 'string') process.stdout.write(`  ${entry}\n`);
		else process.stdout.write(`  ${entry.path}:${entry.line}: ${entry.value}\n`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const full = process.argv.includes('--full');
	const unknown = process.argv.slice(2).filter(argument => argument !== '--full');
	if (unknown.length > 0) {
		process.stderr.write(`Unknown arguments: ${unknown.join(', ')}\n`);
		process.exit(2);
	}
	const result = auditEditorCssOwnership();
	process.stdout.write(`CSS files: ${result.cssFileCount}\n`);
	process.stdout.write(`upstream-identical CSS: ${result.exactCopies.length}\n`);
	process.stdout.write(`upstream-equivalent after branding: ${result.brandingEquivalent.length}\n`);
	process.stdout.write(`upstream brand references: ${result.brandReferences.length}\n`);
	process.stdout.write(`forbidden upstream product roots: ${result.productRoots.length}\n`);
	process.stdout.write(`new upstream brand references: ${result.introducedBrandReferences.length}\n`);
	process.stdout.write(`changed CSS equivalent after branding: ${result.changedBrandingEquivalent.length}\n`);
	if (full) {
		printEntries('upstream-equivalent after branding', result.brandingEquivalent);
		printEntries('existing upstream brand references', result.brandReferences);
	}
	printEntries('upstream-identical CSS', result.exactCopies);
	printEntries('forbidden upstream product roots', result.productRoots);
	printEntries('new upstream brand references', result.introducedBrandReferences);
	printEntries('changed CSS equivalent after branding', result.changedBrandingEquivalent);
	const failed = result.exactCopies.length > 0
		|| result.productRoots.length > 0
		|| result.introducedBrandReferences.length > 0
		|| result.changedBrandingEquivalent.length > 0;
	if (!failed && result.brandingEquivalent.length > 0) process.stdout.write('Review required: branding-only differences are debt, not completed independent CSS.\n');
	process.exitCode = failed ? 1 : 0;
}
