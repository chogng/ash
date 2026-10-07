import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "mocha";
import ts from "typescript";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const sourceRoot = resolve(desktopRoot, "src/ash");
test("DOM context queries have one canonical owner", () => {
	const expectedSymbols = ["getWindow", "getDocument", "getActiveElement", "getActiveDocument"];
	const ownerFiles = [
		resolve(sourceRoot, "base/browser/dom.ts"),
		resolve(sourceRoot, "base/browser/focus.ts"),
		resolve(sourceRoot, "base/browser/window.ts"),
	];
	const owners = Object.fromEntries(expectedSymbols.map(symbol => [symbol, [] as string[]]));
	for (const file of ownerFiles) {
		const source = readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		for (const statement of sourceFile.statements) {
			if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
			const matches = owners[statement.name.text];
			if (matches) matches.push(relative(desktopRoot, file).replaceAll("\\", "/"));
		}
	}
	assert.deepEqual(owners, Object.fromEntries(expectedSymbols.map(symbol => [symbol, ["src/ash/base/browser/dom.ts"]])));
});

test("the retired DOM builder and binding protocol stay removed", () => {
	assert.equal(existsSync(resolve(sourceRoot, "base/browser/domBuilder.ts")), false);
	const violations = frontendTypeScriptFiles().filter(file => /domBuilder\.js|\bReadableValue\b|\bbind(?:Text|Attribute|Class|Children)\b/u.test(readFileSync(file, "utf8"))).map(file => relative(desktopRoot, file).replaceAll("\\", "/"));
	assert.deepEqual(violations, []);
});

function frontendTypeScriptFiles(): string[] {
	return [resolve(sourceRoot), resolve(desktopRoot, "test")].flatMap(collectTypeScriptFiles);
}

function collectTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(path);
	}
	return files;
}
