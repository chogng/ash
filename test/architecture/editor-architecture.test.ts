import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const editorRoot = resolve(desktopRoot, "src/ash/editor");
const workbenchImportPattern = /(?:from\s+|import\s*(?:\(\s*)?)["'][^"']*\/workbench\/[^"']*["']/u;

test("Editor keeps explicit feature files without index barrels", () => {
	const indexFiles = collectFiles(editorRoot).filter(file => file.endsWith("\\index.ts") || file.endsWith("/index.ts"));
	assert.deepEqual(indexFiles, []);
});

test("Editor production code does not depend on Workbench or generated transport DTOs", () => {
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") || isTestFile(file)) continue;
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, workbenchImportPattern, relative(editorRoot, file));
		assert.doesNotMatch(source, /from\s+["'][^"']*app-server\/common\/generated[^"']*["']/u, relative(editorRoot, file));
		assert.doesNotMatch(source, /from\s+["'][^"']*platform\/(?:syntax|diff)\/[^"']*["']/u, relative(editorRoot, file));
	}
});

test('Common editor contracts do not import contribution-owned modules', () => {
	for (const file of collectFiles(join(editorRoot, 'common'))) {
		if (!file.endsWith('.ts')) continue;
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu)) {
			const specifier = match[1]!;
			if (!specifier.startsWith('.')) continue;
			const target = relative(editorRoot, resolve(dirname(file), specifier)).replaceAll('\\', '/');
			assert.equal(target.startsWith('contrib/'), false, `${relative(editorRoot, file)} imports ${specifier}`);
		}
	}
});

test('Editor dependency checks distinguish layer paths from Platform filenames', () => {
	assert.doesNotMatch("import { editorBackground } from '../../platform/theme/common/colors/editorColors.js';", workbenchImportPattern);
	assert.match("import { EditorPart } from '../../workbench/browser/parts/editor/editorPart.js';", workbenchImportPattern);
	assert.match("import '../../workbench/browser/workbench.contribution.js';", workbenchImportPattern);
	assert.match("await import('../../workbench/browser/workbench.js');", workbenchImportPattern);
});

test("Editor synchronous layers do not import Electron or generated DTOs", () => {
	const protectedDirectories = [
		"common/config",
		"common/core",
		"common/diff",
		"common/model",
		"common/cursor",
		"common/commands",
		"common/viewLayout",
		"common/viewModel",
	];
	for (const directory of protectedDirectories) {
		for (const file of collectFiles(join(editorRoot, directory))) {
			if (!file.endsWith(".ts")) continue;
			const source = readFileSync(file, "utf8");
			assert.doesNotMatch(source, /from\s+["'][^"']*(?:electron|generated)[^"']*["']/u, relative(editorRoot, file));
		}
	}
});

test('Editor implementation files have an importer or an explicit entrypoint', () => {
	const sourceRoot = resolve(desktopRoot, 'src');
	const sourceFiles = [...collectFiles(sourceRoot), ...collectFiles(resolve(desktopRoot, 'extensions'))].filter(file => file.endsWith('.ts'));
	const editorProductionFiles = sourceFiles.filter(file => file.startsWith(editorRoot) && !isTestFile(file));
	const incoming = new Map(editorProductionFiles.map(file => [architecturePathKey(file), 0]));
	const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/gu;

	for (const sourceFile of sourceFiles) {
		const source = readFileSync(sourceFile, 'utf8');
		for (const match of source.matchAll(importPattern)) {
			const specifier = match[1]!;
			if (!specifier.startsWith('.')) continue;
			const target = architecturePathKey(resolve(dirname(sourceFile), specifier.replace(/\.js$/u, '.ts')));
			if (incoming.has(target)) incoming.set(target, incoming.get(target)! + 1);
		}
	}

	const explicitEntrypoints = new Set([
		resolve(editorRoot, 'editor.main.ts'),
		resolve(editorRoot, 'common/services/editorWebWorkerMain.ts'),
		resolve(editorRoot, 'common/diff/diffWorkerMain.ts'),
	].map(architecturePathKey));
	const unreferenced = editorProductionFiles.filter(file => {
		const key = architecturePathKey(file);
		return incoming.get(key) === 0 && !explicitEntrypoints.has(key);
	}).map(file => relative(editorRoot, file));
	assert.deepEqual(unreferenced, [], 'Editor files without an importer');
});

function architecturePathKey(path: string): string {
	return process.platform === 'win32' ? path.toLowerCase() : path;
}

test("Stanza owns editor DOM and CSS brand classes", () => {
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") && !file.endsWith(".css")) continue;
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /\bmonaco-editor\b/u, relative(editorRoot, file));
	}
});

test("Editor syntax ownership keeps WASM imports behind the syntax adapter", () => {
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") || isTestFile(file)) continue;
		assert.doesNotMatch(readFileSync(file, "utf8"), /^import (?!type\b).*from ['"]@vscode\/tree-sitter-wasm['"]/mu, relative(editorRoot, file));
	}
});
test("Editor widget and view composition do not import optional contributions", () => {
	for (const file of [
		"browser/widget/codeEditor/codeEditorWidget.ts",
		"browser/view/viewController.ts",
		"browser/editorExtensions.ts",
	]) {
		assert.doesNotMatch(readFileSync(editorSource(file), "utf8"), /from\s+["'][^"']*\/contrib\//u, file);
	}
});
function collectFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...collectFiles(file));
		else result.push(file);
	}
	return result;
}

function isTestFile(file: string): boolean {
	return /[\\/]test[\\/]|\.test\.ts$/u.test(file);
}

function editorSource(file: string): string {
	return join(editorRoot, file);
}
