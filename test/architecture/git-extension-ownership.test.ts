import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { test } from 'mocha';
import ts from 'typescript';
import { findDesktopRoot } from './testPaths.js';

const root = findDesktopRoot(import.meta.dirname);
test('Git frontend policy is owned by the extension and cannot be imported into core', () => {
	assert.equal(existsSync(resolve(root, 'src/ash/workbench/contrib/git')), false);
	const hostContracts = new Set(['src/ash/platform/git/common/localGitService.ts', 'src/ash/platform/git/browser/appServerLocalGitService.ts']);
	const contract = ts.createSourceFile('localGitService.ts', readFileSync(resolve(root, 'src/ash/platform/git/common/localGitService.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
	const service = contract.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'ILocalGitService');
	assert.ok(service && ts.isInterfaceDeclaration(service));
	// Session GitHub references can inspect an authorized historical directory without
	// installing a window Git provider. Repository mutations and frontend policy stay in the extension.
	assert.deepEqual(
		service.members
			.filter(ts.isMethodSignature)
			.map(member => member.name.getText(contract))
			.sort(),
		['cancel', 'clone', 'readRepositoryContexts'],
	);
	const violations: string[] = [];
	function inspect(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === 'test' || entry.name === 'generated' || entry.name === '.build') {
				continue;
			}
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				inspect(path);
				continue;
			}
			if (!entry.name.endsWith('.ts')) {
				continue;
			}
			const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
			function inspectNode(node: ts.Node): void {
				const module =
					ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
						? node.moduleSpecifier
						: ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
							? node.arguments[0]
							: undefined;
				if (module && ts.isStringLiteral(module) && module.text.startsWith('.')) {
					const target = relative(root, resolve(dirname(path), module.text.replace(/\.js$/u, '.ts'))).replaceAll('\\', '/');
					if (/^(?:extensions\/git\/|src\/ash\/workbench\/contrib\/git\/)/u.test(target) || (target.startsWith('src/ash/platform/git/') && !hostContracts.has(target)))
						violations.push(relative(root, path));
				}
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
			if (entry.name === 'test') {
				continue;
			}
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				inspect(path);
				continue;
			}
			if (!path.endsWith('.ts')) {
				continue;
			}
			const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
			function inspectNode(node: ts.Node): void {
				if (
					ts.isPropertyAssignment(node) &&
					(node.name.getText(source) === 'id' || node.name.getText(source) === 'key') &&
					ts.isStringLiteral(node.initializer) &&
					/^(?:git\.|ash\.git\.)/.test(node.initializer.text)
				) {
					violations.push(`${relative(root, path)}:${node.initializer.text}`);
				}
				ts.forEachChild(node, inspectNode);
			}
			inspectNode(source);
		}
	}
	inspect(resolve(root, 'src/ash/workbench/contrib/scm'));
	inspect(resolve(root, 'src/ash/workbench/contrib/mergeEditor'));
	assert.deepEqual(violations, []);
});
