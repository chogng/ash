import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'mocha';
import * as ts from 'typescript';
import { findDesktopRoot } from './testPaths.js';

test('Academy collaboration contracts erase all host dependencies at runtime', () => {
	const file = resolve(findDesktopRoot(import.meta.dirname), 'extensions/academy/common/services/collabService.ts');
	const emitted = ts.transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
	}).outputText;
	const module = ts.createSourceFile('contract.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	// An empty export marks the file as a module without loading or constructing host code.
	assert.ok(module.statements.every(statement => ts.isExportDeclaration(statement) && !statement.moduleSpecifier
		&& statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length === 0), emitted);
});

test('Desktop and Browser Sessions both enable Docs backup restoration', () => {
	const root = findDesktopRoot(import.meta.dirname);
	for (const file of ['src/ash/sessions/electron-browser/sessions.main.ts', 'src/ash/sessions/browser/web.main.ts']) {
		assert.ok(readFileSync(resolve(root, file), 'utf8').includes("'sessions.docs.backup'"), file);
	}
});
