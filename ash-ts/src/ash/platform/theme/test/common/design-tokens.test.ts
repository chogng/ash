import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "mocha";
import { colorCssVariable, sizeCssVariable, sizeIdentifiers } from "../../common/colorTheme.js";
import { Colors } from "../../common/colorRegistry.js";
// This audit covers editor CSS as well as platform CSS.
import "../../../../editor/common/core/editorColorRegistry.js";

test("CSS consumes registered design tokens and isolates intentional color samples", async () => {
	const registered = new Set([...Colors.getColors().map(({ id }) => colorCssVariable(id)), ...sizeIdentifiers.map(sizeCssVariable)]);
	const platformVariables = new Set(["--ash-font-family", "--ash-font-family-monospace", "--ash-context-view-layer", "--ash-z-index-context-view", "--ash-z-index-quick-input", "--ash-z-index-sash"]);
	const componentPresentationVariables = new Set([
		"--ash-scrollbar-slider-size",
		"--ash-icon-label-text-overflow",
		"--ash-sash-inset-gap",
		"--ash-tab-list-inactive-background",
		"--ash-terminal-command-gutter-width",
	]);
	const intentionalColorFiles = new Set([
		"base/browser/ui/icon/icon.css",
		"editor/browser/viewParts/viewLines/viewLines.css",
		"editor/browser/viewParts/decorations/decorations.css",
		"editor/contrib/colorPicker/browser/colorPicker.css",
	]);
	const sourceRoot = join(process.cwd(), "src", "ash");
	const unknownVariables: string[] = [];
	const rawColors: string[] = [];
	for (const file of await cssFiles(sourceRoot)) {
		const source = await readFile(file, "utf8");
		const name = relative(sourceRoot, file).replaceAll("\\", "/");
		for (const match of source.matchAll(/var\((--ash-[a-zA-Z0-9-]+)/g)) {
			if (!registered.has(match[1]!) && !platformVariables.has(match[1]!) && !componentPresentationVariables.has(match[1]!)) unknownVariables.push(`${name}: ${match[1]}`);
		}
		if (!intentionalColorFiles.has(name)) {
			for (const [index, line] of source.split(/\r?\n/).entries()) {
				if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(line)) rawColors.push(`${name}:${index + 1}`);
			}
		}
	}
	assert.deepEqual(unknownVariables, []);
	assert.deepEqual(rawColors, []);
});

async function cssFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await cssFiles(path));
		else if (entry.name.endsWith(".css")) result.push(path);
	}
	return result;
}
