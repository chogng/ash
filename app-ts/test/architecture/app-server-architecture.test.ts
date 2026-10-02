import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'mocha';
import ts from 'typescript';
import { findDesktopRoot } from './testPaths.js';

const sourceRoot = resolve(findDesktopRoot(import.meta.dirname), 'src/ash');
const generatedRoot = resolve(sourceRoot, 'platform/app-server/common/generated');
// These contribution-owned implementations convert transport records to their frontend contracts.
const contributionAdapters = new Set([
	'sessions/contrib/providers/appServer/browser/appServerSessionsProvider.ts',
	'sessions/contrib/providers/appServer/browser/appServerTeamsProvider.ts',
	'workbench/contrib/git/browser/gitService.ts',
]);

test('generated protocol dependencies stay in transport contracts and runtime adapters', () => {
	const violations = files(sourceRoot).flatMap(file => generatedDependencyViolations(relative(sourceRoot, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')));
	assert.deepEqual(violations, [], 'UI, editor, and public domain services must use frontend-owned contracts');
});

test('generated dependency checks recognize contribution adapters without allowing neighboring UI or contracts', () => {
	for (const name of contributionAdapters) {
		assert.deepEqual(generatedDependencyViolations(name, `import type { Session } from '${generatedSpecifier(name)}';`), [], name);
	}
	for (const name of [
		'sessions/contrib/providers/appServer/browser/sessionView.ts',
		'sessions/contrib/providers/appServer/common/sessionsProvider.ts',
		'sessions/services/sessions/common/session.ts',
		'workbench/contrib/git/browser/gitViewPane.ts',
		'workbench/contrib/git/common/gitService.ts',
		'workbench/services/chat/common/chatService.ts',
		'editor/browser/widget/codeEditorWidget.ts',
		'platform/files/common/files.ts',
	]) {
		const specifier = generatedSpecifier(name);
		assert.deepEqual(generatedDependencyViolations(name, `import type { Session } from '${specifier}';`), [`${name}: ${specifier}`], name);
	}
});

test('shared product command metadata does not permit transport imports in the Chat contract', () => {
	const name = 'workbench/services/chat/common/chatService.ts';
	const specifier = generatedSpecifier(name);
	assert.deepEqual(generatedDependencyViolations(name, `import { PRODUCT_SLASH_COMMANDS } from '${specifier}';`), []);
	assert.deepEqual(generatedDependencyViolations(name, `import { PRODUCT_SLASH_COMMANDS as commands } from '${specifier}';`), []);
	for (const statement of [
		`import { PRODUCT_SLASH_COMMANDS, type Session } from '${specifier}';`,
		`import type { PRODUCT_SLASH_COMMANDS } from '${specifier}';`,
		`import { type PRODUCT_SLASH_COMMANDS } from '${specifier}';`,
		`import commands from '${specifier}';`,
		`import * as commands from '${specifier}';`,
		`export { PRODUCT_SLASH_COMMANDS } from '${specifier}';`,
		`const commands = await import('${specifier}');`,
	]) {
		assert.deepEqual(generatedDependencyViolations(name, statement), [`${name}: ${specifier}`], statement);
	}
});

test('runtime adapters still reject generated deep imports and retired protocol paths', () => {
	for (const name of contributionAdapters) {
		for (const specifier of [generatedSpecifier(name, 'types/Session.js'), '../generated/app-server/types/Session.js']) {
			assert.deepEqual(generatedDependencyViolations(name, `import type { Session } from '${specifier}';`), [`${name}: ${specifier}`], name);
		}
	}
});

function generatedDependencyViolations(name: string, contents: string): string[] {
	const file = resolve(sourceRoot, name);
	const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
	const allowed = /^platform\/app-server\//u.test(name)
		|| /^platform\/[^/]+\/common\/[^/]*Api\.ts$/u.test(name)
		|| /^platform\/[^/]+\/(?:browser|electron-browser|electron-main|node)\//u.test(name)
		|| /^(?:workbench|sessions)\/services\/[^/]+\/(?:browser|electron-browser)\//u.test(name)
		|| contributionAdapters.has(name);
	const violations: string[] = [];
	function visit(node: ts.Node): void {
		if (ts.isStringLiteral(node) && node.text.startsWith('.')) {
			const target = relative(generatedRoot, resolve(dirname(file), node.text)).replaceAll('\\', '/');
			const generated = target !== '..' && !target.startsWith('../') && !target.includes(':');
			if (node.text.includes('generated/app-server') || generated && (target.startsWith('types/') || !allowed && !isProductCommandMetadata(name, target, node))) {
				violations.push(`${name}: ${node.text}`);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return violations;
}

function isProductCommandMetadata(name: string, target: string, node: ts.StringLiteral): boolean {
	// Product command definitions have one cross-client owner; this permits their values, never wire DTOs.
	if (name !== 'workbench/services/chat/common/chatService.ts' || target !== 'index.js' || !ts.isImportDeclaration(node.parent)) {
		return false;
	}
	const clause = node.parent.importClause;
	const bindings = clause?.namedBindings;
	return !!clause && !clause.isTypeOnly && !clause.name && !!bindings && ts.isNamedImports(bindings)
		&& bindings.elements.length > 0
		&& bindings.elements.every(binding => !binding.isTypeOnly && (binding.propertyName ?? binding.name).text === 'PRODUCT_SLASH_COMMANDS');
}

function generatedSpecifier(name: string, target = 'index.js'): string {
	return relative(dirname(resolve(sourceRoot, name)), resolve(generatedRoot, target)).replaceAll('\\', '/');
}

function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === 'generated' || entry.name === 'test' ? [] : files(path);
		return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
	});
}
