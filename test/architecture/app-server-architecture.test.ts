import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'mocha';
import ts from 'typescript';
import { findDesktopRoot } from './testPaths.js';

const sourceRoot = resolve(findDesktopRoot(import.meta.dirname), 'src/ash');
const generatedRoot = resolve(findDesktopRoot(import.meta.dirname), '.build/protocol/typescript');

test('generated protocol dependencies stay in transport contracts and runtime adapters', () => {
	assert.equal(existsSync(join(generatedRoot, 'index.ts')), true, 'consumers share the Rust-owned protocol snapshot');
	assert.equal(existsSync(resolve(sourceRoot, '../../crates/app-server-protocol/schema')), false, 'generated contracts stay outside the source tree');
	assert.equal(existsSync(resolve(sourceRoot, '../../generated/app-server')), false, 'retired protocol snapshot');
	assert.equal(existsSync(join(sourceRoot, 'platform/agentHost/common/generated')), false, 'retired frontend protocol copy');
	const violations: string[] = [];
	for (const file of files(sourceRoot)) {
		const name = relative(sourceRoot, file).replaceAll('\\', '/');
		if (name.includes('/test/') || name.includes('/generated/')) continue;
		const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		const domainContract = /^platform\/agentHost\/common\/(?:agent|agentService|agentExecutionSettingsService|agentHostFileSystemProvider)\.ts$/u.test(name)
			|| /^platform\/(?:models|automations)\/common\//u.test(name)
			|| /^platform\/extensions\/common\/extension(?:Backend|Host)Api\.ts$/u.test(name)
			|| name === 'platform/files/common/fileApi.ts';
		const allowed = !domainContract && (/^platform\/agentHost\//u.test(name)
			|| /^platform\/[^/]+\/common\/[^/]*Api\.ts$/u.test(name)
			|| /^platform\/[^/]+\/(?:browser|electron-browser|electron-main|node)\//u.test(name)
			|| /^(?:workbench|sessions)\/services\/[^/]+\/(?:browser|electron-browser)\//u.test(name)
			|| /^sessions\/contrib\/providers\/agentHost\/browser\//u.test(name)
			// These native carriers terminate protocol connections at the product host boundary.
			|| name === 'workbench/electron-browser/rendererApi.ts'
			|| name === 'sessions/contrib/chatgptweb/electron-main/chatGPTAuthentication.ts');
		// Generated product definitions are metadata, not wire data or transport APIs.
		const metadataOnly = source.statements.filter(ts.isImportDeclaration).every(statement => {
			if (!ts.isStringLiteral(statement.moduleSpecifier) || protocolPath(file, statement.moduleSpecifier.text) === undefined) return true;
			const bindings = statement.importClause?.namedBindings;
			return bindings && ts.isNamedImports(bindings) && bindings.elements.every(element =>
				['APPROVAL_MODE_DEFINITIONS', 'PRODUCT_SLASH_COMMANDS'].includes((element.propertyName ?? element.name).text));
		});
		function visit(node: ts.Node): void {
			if (ts.isStringLiteral(node) && node.text.startsWith('.')) {
				const target = protocolPath(file, node.text);
				if (node.text.includes('generated/app-server') || node.text.includes('app-server/common/generated') || target !== undefined && (!allowed && !metadataOnly || target.startsWith('types/'))) violations.push(`${name}: ${node.text}`);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	assert.deepEqual(violations, [], 'UI, editor, and public domain services must use frontend-owned contracts');
});

test('File notifications are routed only by file runtime adapters', () => {
	const violations: string[] = [];
	for (const file of files(sourceRoot)) {
		const name = relative(sourceRoot, file).replaceAll('\\', '/');
		if (/^platform\/files\/(?:browser|electron-browser|electron-main|node)\//u.test(name)) continue;
		const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		function visit(node: ts.Node): void {
			if (ts.isStringLiteral(node) && node.text === 'fs/changed') violations.push(name);
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	assert.deepEqual(violations, [], 'File consumers must subscribe to their connection-owned file domain');
});

test('Agent connection contracts do not depend on Renderer host composition', () => {
	for (const name of ['agentService.ts', 'agentHostConnectionsService.ts']) {
		const file = join(sourceRoot, 'platform/agentHost/common', name);
		const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		const dependencies = source.statements.filter(ts.isImportDeclaration).map(declaration => (declaration.moduleSpecifier as ts.StringLiteral).text);
		assert.deepEqual(dependencies.filter(dependency => dependency.includes('/renderer/')), [], name);
	}
});

function protocolPath(file: string, specifier: string): string | undefined {
	if (!specifier.startsWith('.')) return undefined;
	const target = relative(generatedRoot, resolve(dirname(file), specifier)).replaceAll('\\', '/');
	return target === '..' || target.startsWith('../') || target.includes(':') ? undefined : target;
}

function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === 'generated' || entry.name === 'test' ? [] : files(path);
		return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
	});
}
