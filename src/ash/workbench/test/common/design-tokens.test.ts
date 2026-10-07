import '../../../platform/theme/common/colors/chartsColors.js';
import '../../../platform/theme/common/colors/componentColors.js';
import '../../../platform/theme/common/colors/editorColors.js';
import '../../../platform/theme/common/colors/inputColors.js';
import '../../../platform/theme/common/colors/listColors.js';
import '../../../platform/theme/common/colors/menuColors.js';
import '../../../platform/theme/common/colors/minimapColors.js';
import '../../../platform/theme/common/colors/miscColors.js';
import '../../../platform/theme/common/colors/quickpickColors.js';
import '../../../platform/theme/common/colors/searchColors.js';
import '../../contrib/welcomeGettingStarted/browser/gettingStartedColors.js';
import '../../../sessions/contrib/creator/browser/widget/designToolsWidget.js';
import '../../../platform/theme/common/colors/baseColors.js';
import '../../../platform/theme/common/sizes/baseSizes.js';
import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "mocha";
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
import "../../../sessions/common/theme.js";

test('CSS variable manifest matches registered colors and sizes', async () => {
	const path = join(process.cwd(), 'build/lib/stylelint/ash-known-variables.json');
	const variables = JSON.parse(await readFile(path, 'utf8'));
	assert.deepEqual(variables.colors, Colors.getColors().map(({ id }) => colorCssVariable(id)).sort(), 'Run pnpm stylelint:update and review the manifest.');
	assert.deepEqual(variables.sizes, Sizes.getSizes().map(({ id }) => asCssVariableName(id)).sort(), 'Run pnpm stylelint:update and review the manifest.');
});

test("CSS isolates intentional color samples", async () => {
	const intentionalColorFiles = new Set([
		"base/browser/ui/colorPicker/colorPicker.css",
		"base/browser/ui/lxicons/lxicon.css",
		"editor/browser/viewParts/viewLines/viewLines.css",
		"editor/browser/viewParts/decorations/decorations.css",
		"editor/contrib/colorPicker/browser/colorPicker.css",
	]);
	const sourceRoot = join(process.cwd(), "src", "ash");
	const rawColors: string[] = [];
	for (const file of (await presentationFiles(sourceRoot)).filter(file => file.endsWith(".css"))) {
		const source = await readFile(file, "utf8");
		const name = relative(sourceRoot, file).replaceAll("\\", "/");
		if (!intentionalColorFiles.has(name)) {
			for (const [index, line] of source.split(/\r?\n/).entries()) {
				if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(line)) rawColors.push(`${name}:${index + 1}`);
			}
		}
	}
	assert.deepEqual(rawColors, []);
});

async function presentationFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await presentationFiles(path));
		else if (entry.name.endsWith(".css") || entry.name.endsWith(".ts") && !path.includes("/test/")) result.push(path);
	}
	return result;
}
