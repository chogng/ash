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
			function inspectNode(node: ts.Node): void {
				const module = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
				if (module && ts.isStringLiteral(module) && /extensions\/git|(?:contrib|platform)\/git\//.test(module.text)) { violations.push(relative(root, path)); }
				ts.forEachChild(node, inspectNode);
			}
			inspectNode(source);
		}
	}
	inspect(resolve(root, 'src/ash'));
	assert.deepEqual(violations, []);
});

test('generic SCM and merge editors do not register Git commands or use Git-owned NLS', () => {
	const violations: string[] = [];
	function inspect(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === 'test') { continue; }
			const path = join(directory, entry.name);
			if (entry.isDirectory()) { inspect(path); continue; }
			if (!path.endsWith('.ts')) { continue; }
			const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
			function inspectNode(node: ts.Node): void {
				if (ts.isPropertyAssignment(node) && (node.name.getText(source) === 'id' || node.name.getText(source) === 'key') && ts.isStringLiteral(node.initializer) && /^(?:git\.|ash\.git\.)/.test(node.initializer.text)) { violations.push(`${relative(root, path)}:${node.initializer.text}`); }
				ts.forEachChild(node, inspectNode);
			}
			inspectNode(source);
		}
	}
	inspect(resolve(root, 'src/ash/workbench/contrib/scm'));
	inspect(resolve(root, 'src/ash/workbench/contrib/mergeEditor'));
	assert.deepEqual(violations, []);
});
