import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'mocha';
import ts from 'typescript';
import { findDesktopRoot } from './testPaths.js';

const sourceRoot = resolve(findDesktopRoot(import.meta.dirname), 'src/ash');
const generatedRoot = resolve(sourceRoot, 'platform/app-server/common/generated');

test('generated protocol dependencies stay in transport contracts and runtime adapters', () => {
	const violations: string[] = [];
	for (const file of files(sourceRoot)) {
		const name = relative(sourceRoot, file).replaceAll('\\', '/');
		if (name.includes('/test/') || name.includes('/generated/')) continue;
		const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		const allowed = /^platform\/app-server\//u.test(name)
			|| /^platform\/[^/]+\/common\/[^/]*Api\.ts$/u.test(name)
			|| /^platform\/[^/]+\/(?:browser|electron-browser|electron-main|node)\//u.test(name)
			|| /^(?:workbench|sessions)\/services\/[^/]+\/(?:browser|electron-browser)\//u.test(name);
		function visit(node: ts.Node): void {
			if (ts.isStringLiteral(node) && node.text.startsWith('.')) {
				const target = relative(generatedRoot, resolve(dirname(file), node.text)).replaceAll('\\', '/');
				const generated = target !== '..' && !target.startsWith('../') && !target.includes(':');
				if (node.text.includes('generated/app-server') || generated && (!allowed || target.startsWith('types/'))) violations.push(`${name}: ${node.text}`);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	assert.deepEqual(violations, [], 'UI, editor, and public domain services must use frontend-owned contracts');
});

function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === 'generated' || entry.name === 'test' ? [] : files(path);
		return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
	});
}
