import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "mocha";
import * as ts from "typescript";

test("TypeScript sources use private modifiers instead of private identifiers", async () => {
	const violations: string[] = [];
	for (const sourceRoot of [join(process.cwd(), "src"), join(process.cwd(), "test")]) {
		for (const file of await typescriptFiles(sourceRoot)) {
			const source = await readFile(file, "utf8");
			const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
			visit(sourceFile, (identifier) => {
				const line = sourceFile.getLineAndCharacterOfPosition(identifier.getStart(sourceFile)).line + 1;
				violations.push(`${relative(process.cwd(), file).replaceAll("\\", "/")}:${line}: ${identifier.text}`);
			});
		}
	}
	assert.deepEqual(violations, []);
});

async function typescriptFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await typescriptFiles(path));
		else if (entry.name.endsWith(".ts")) result.push(path);
	}
	return result;
}

function visit(node: ts.Node, onPrivateIdentifier: (identifier: ts.PrivateIdentifier) => void): void {
	if (ts.isPrivateIdentifier(node)) onPrivateIdentifier(node);
	ts.forEachChild(node, (child) => visit(child, onPrivateIdentifier));
}
