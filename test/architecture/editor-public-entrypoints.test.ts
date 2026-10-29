import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'mocha';
import { findDesktopRoot } from './testPaths.js';

const editorRoot = resolve(findDesktopRoot(import.meta.dirname), 'src/ash/editor');

function exists(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

test('plain-text entrypoints have no runtime dependency on editor capability packages', async () => {
	const ts = await import('typescript');
	const { dirname } = await import('node:path');
	const root = findDesktopRoot(import.meta.dirname);
	for (const entry of ['editor.api.ts', 'editor.main.ts']) {
		const seen = new Set<string>();
		const pending = [join(editorRoot, entry)];
		while (pending.length) {
			const file = pending.pop()!;
			if (seen.has(file) || !exists(file)) continue;
			seen.add(file);
			assert.equal(file.startsWith(join(root, 'extensions')), false, `${entry} loads ${file}`);
			if (!file.endsWith('.ts')) continue;
			const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
			for (const node of source.statements) {
				if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
				if (
					ts.isImportDeclaration(node) &&
					(node.importClause?.isTypeOnly ||
						(node.importClause?.namedBindings &&
							ts.isNamedImports(node.importClause.namedBindings) &&
							!node.importClause.name &&
							node.importClause.namedBindings.elements.every(value => value.isTypeOnly)))
				)
					continue;
				if (ts.isExportDeclaration(node) && node.isTypeOnly) continue;
				if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
				const value = node.moduleSpecifier.text;
				if (!value.startsWith('.')) continue;
				pending.push(resolve(dirname(file), value.replace(/\.js$/u, '.ts')));
			}
		}
	}
});
