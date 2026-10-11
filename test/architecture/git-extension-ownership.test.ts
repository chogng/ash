import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { test } from 'mocha';
import ts from 'typescript';
import { findDesktopRoot } from './testPaths.js';

const root = findDesktopRoot(import.meta.dirname);
test('Git frontend policy is owned by the extension and cannot be imported into core', () => {
	assert.equal(existsSync(resolve(root, 'src/ash/workbench/contrib/git')), false);
	assert.equal(existsSync(resolve(root, 'src/ash/platform/git')), false);
	const violations: string[] = [];
	function inspect(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === 'test' || entry.name === 'generated') { continue; }
			const path = join(directory, entry.name);
			if (entry.isDirectory()) { inspect(path); continue; }
			if (!entry.name.endsWith('.ts')) { continue; }
			const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
			for (const statement of source.statements) {
				if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) { continue; }
				if (/extensions\/git|(?:contrib|platform)\/git\//.test(statement.moduleSpecifier.text)) { violations.push(relative(root, path)); }
			}
		}
	}
	inspect(resolve(root, 'src/ash'));
	assert.deepEqual(violations, []);
});
