import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "mocha";
import ts from 'typescript';
import { colorCssVariable } from "../../../platform/theme/common/colorUtils.js";
import { Colors } from "../../../platform/theme/common/colorRegistry.js";
import { Sizes } from "../../../platform/theme/common/sizeRegistry.js";
import { asCssVariableName } from "../../../platform/theme/common/sizeUtils.js";
import "../../../editor/common/core/editorColorRegistry.js";
import "../../../editor/browser/widget/multiDiffEditor/colors.js";
import "../../common/theme.js";
import "../../contrib/chat/common/widget/chatColors.js";
import "../../contrib/pdf/common/pdfColors.js";
import "../../contrib/preferences/common/settingsEditorColorRegistry.js";
import "../../contrib/terminal/common/terminalColorRegistry.js";
import "../../../sessions/common/sessionsColors.js";
import "../../contrib/welcomeGettingStarted/browser/gettingStartedColors.js";

test("CSS consumes registered design tokens and isolates intentional color samples", async () => {
	const registered = new Set([...Colors.getColors().map(({ id }) => colorCssVariable(id)), ...Sizes.getSizes().map(({ id }) => asCssVariableName(id))]);
	const platformVariables = new Set(["--ash-font-family", "--ash-font-family-monospace", "--ash-context-view-layer", "--ash-z-index-context-view", "--ash-z-index-quick-input", "--ash-z-index-sash"]);
	const componentPresentationVariables = new Set([
		"--ash-editor-token-foreground",
		"--ash-scrollbar-slider-size",
		"--ash-icon-label-text-overflow",
		"--ash-sash-inset-gap",
		"--ash-split-view-separator-border",
		"--ash-tab-list-inactive-background",
		"--ash-terminal-command-gutter-width",
	]);
	const intentionalColorFiles = new Set([
		"base/browser/ui/lxicons/lxicon.css",
		"editor/browser/viewParts/viewLines/viewLines.css",
		"editor/browser/viewParts/decorations/decorations.css",
		"editor/contrib/colorPicker/browser/colorPicker.css",
	]);
	const sourceRoot = join(process.cwd(), "src", "ash");
	const sources: { file: string; source: string }[] = [];
	for (const file of await styleSourceFiles(sourceRoot)) sources.push({ file, source: await readFile(file, 'utf8') });
	for (const { file, source } of sources) {
		for (const variable of declaredComponentVariables(file, source)) componentPresentationVariables.add(variable);
	}
	const unknownVariables: string[] = [];
	const rawColors: string[] = [];
	for (const { file, source } of sources) {
		if (!file.endsWith('.css')) continue;
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

test('component CSS variables require an actual declaration rather than a reference or comment', () => {
	assert.deepEqual([...declaredComponentVariables('component.css', '/* --ash-comment: 0; */ .part { --ash-local: var(--ash-foreground); color: var(--ash-missing); }')], ['--ash-local']);
	assert.deepEqual([...declaredComponentVariables('component.ts', `
		// node.style.setProperty('--ash-comment', '0');
		node.style.setProperty('--ash-width', width);
		const styles = { '--ash-local-color': color };
		node.style.getPropertyValue('--ash-missing');
	`)], ['--ash-width', '--ash-local-color']);
});

function declaredComponentVariables(file: string, source: string): Set<string> {
	const variables = new Set<string>();
	if (file.endsWith('.css')) {
		for (const match of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--ash-[a-zA-Z0-9-]+)\s*:/g)) variables.add(match[1]!);
		return variables;
	}
	if (!source.includes('--ash-')) return variables;
	const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const visit = (node: ts.Node): void => {
		const name = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setProperty'
			? node.arguments[0]
			: ts.isPropertyAssignment(node) ? node.name : undefined;
		if (name && ts.isStringLiteral(name) && /^--ash-[a-zA-Z0-9-]+$/.test(name.text)) variables.add(name.text);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return variables;
}

async function styleSourceFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() && entry.name !== 'test') result.push(...await styleSourceFiles(path));
		else if (entry.isFile() && /\.(css|ts)$/.test(entry.name)) result.push(path);
	}
	return result;
}
