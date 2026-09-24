import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const localRoot = resolve(repositoryRoot, 'app-ts/src/ash/editor');
const upstreamRoot = resolve(repositoryRoot, '../vscode/src/vs/editor');
const scope = normalizeScope(process.argv[2] ?? '');

const localFiles = readProductionFiles(localRoot, scope);
const upstreamFiles = readProductionFiles(upstreamRoot, scope);
const localByFoldedPath = indexByFoldedPath(localFiles);
const upstreamByFoldedPath = indexByFoldedPath(upstreamFiles);
const foldedPaths = [...new Set([...localByFoldedPath.keys(), ...upstreamByFoldedPath.keys()])].sort();
const rows = foldedPaths.map(foldedPath => classify(localByFoldedPath.get(foldedPath), upstreamByFoldedPath.get(foldedPath)));

for (const row of rows) {
	process.stdout.write(`${row.status.padEnd(17)} ${row.local ?? '-'}${row.upstream && row.upstream !== row.local ? ` -> ${row.upstream}` : ''}\n`);
}

const counts = new Map();
for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
process.stdout.write('\n');
for (const status of ['same-path', 'case-mismatch', 'local-only', 'upstream-only']) {
	process.stdout.write(`${status}: ${counts.get(status) ?? 0}\n`);
}
process.stdout.write(`local production files: ${localFiles.length}\n`);
process.stdout.write(`upstream production files: ${upstreamFiles.length}\n`);

function readProductionFiles(root, requestedScope) {
	const start = requestedScope ? resolve(root, requestedScope) : root;
	if (!existsSync(start)) return [];
	return walk(start)
		.filter(isProductionSource)
		.map(file => normalizePath(relative(root, file)))
		.sort();
}

function walk(directory) {
	const result = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'test') result.push(...walk(path));
		} else if (entry.isFile()) {
			result.push(path);
		}
	}
	return result;
}

function isProductionSource(file) {
	return /\.(?:css|js|ts|tsx)$/u.test(file);
}

function indexByFoldedPath(files) {
	const result = new Map();
	for (const file of files) {
		const folded = file.toLocaleLowerCase('en-US');
		if (result.has(folded)) throw new Error(`Case-colliding paths: ${result.get(folded)} and ${file}`);
		result.set(folded, file);
	}
	return result;
}

function classify(local, upstream) {
	if (local && upstream) return { status: local === upstream ? 'same-path' : 'case-mismatch', local, upstream };
	if (local) return { status: 'local-only', local };
	return { status: 'upstream-only', upstream, local: undefined };
}

function normalizeScope(value) {
	const normalized = normalizePath(value).replace(/^\/+|\/+$/gu, '');
	if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Scope must stay inside editor: ${value}`);
	return normalized;
}

function normalizePath(value) {
	return value.split(sep).join('/');
}
