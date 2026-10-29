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
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'mocha';
import { colorCssVariable } from '../../../platform/theme/common/colorUtils.js';
import { Colors } from '../../../platform/theme/common/colorRegistry.js';
import { Sizes } from '../../../platform/theme/common/sizeRegistry.js';
import { asCssVariableName } from '../../../platform/theme/common/sizeUtils.js';
import '../../../editor/common/core/editorColorRegistry.js';
import '../../contrib/debug/browser/debugColors.js';
import '../../../sessions/contrib/creator/browser/widget/designToolsWidget.js';
import '../../../editor/browser/widget/multiDiffEditor/colors.js';
import '../../common/theme.js';
import '../../contrib/chat/common/widget/chatColors.js';
import '../../contrib/preferences/common/settingsEditorColorRegistry.js';
import '../../contrib/preferences/browser/keybindingsEditor.js';
import '../../contrib/scm/browser/scmHistory.js';
import '../../contrib/terminal/common/terminalColorRegistry.js';
import '../../contrib/terminalContrib/commandGuide/browser/terminal.commandGuide.contribution.js';
import '../../../sessions/common/theme.js';

test('CSS variable manifest matches registered colors and sizes', async () => {
	const path = join(process.cwd(), 'build/lib/stylelint/ash-known-variables.json');
	const variables = JSON.parse(await readFile(path, 'utf8'));
	assert.deepEqual(
		variables.colors,
		Colors.getColors()
			.map(({ id }) => colorCssVariable(id))
			.sort(),
		'Run pnpm stylelint:update and review the manifest.',
	);
	assert.deepEqual(
		variables.sizes,
		Sizes.getSizes()
			.map(({ id }) => asCssVariableName(id))
			.sort(),
		'Run pnpm stylelint:update and review the manifest.',
	);
});

test('CSS isolates intentional color samples', async () => {
	const intentionalColorFiles = new Set([
		'base/browser/ui/colorPicker/colorPicker.css',
		'base/browser/ui/lxicons/lxicon.css',
		'editor/browser/viewParts/viewLines/viewLines.css',
		'editor/browser/viewParts/decorations/decorations.css',
		'editor/contrib/colorPicker/browser/colorPicker.css',
	]);
	const sourceRoot = join(process.cwd(), 'src', 'ash');
	const rawColors: string[] = [];
	for (const file of (await presentationFiles(sourceRoot)).filter(file => file.endsWith('.css'))) {
		const source = await readFile(file, 'utf8');
		const name = relative(sourceRoot, file).replaceAll('\\', '/');
		if (!intentionalColorFiles.has(name)) {
			for (const line of rawColorLines(source)) rawColors.push(`${name}:${line}`);
		}
	}
	assert.deepEqual(rawColors, []);
});

test('color scanning excludes alpha mask stops while retaining painted colors on the same line', () => {
	assert.deepEqual(rawColorLines('.mask { mask-image: linear-gradient(to right, rgb(0 0 0 / 16%), black); }'), []);
	assert.deepEqual(
		rawColorLines('.mask { mask-image: linear-gradient(black, transparent); color: rgb(0 0 0); }'),
		[1],
	);
	assert.deepEqual(rawColorLines('.mask { mask-image: linear-gradient(rgb(1 2 3), black); }'), [1]);
	assert.deepEqual(rawColorLines('.surface {\n background: #ffffff;\n}'), [2]);
});

function rawColorLines(source: string): number[] {
	// Black alpha stops describe mask coverage without choosing a painted theme color.
	// Other literal colors, including other mask colors, still require review.
	const painted = source.replace(/\b(?:-webkit-)?mask-image\s*:[^;{}]*;/gu, declaration =>
		declaration.replace(/\brgb\(0\s+0\s+0\s*\/\s*\d+(?:\.\d+)?%\)/gu, color => ' '.repeat(color.length)),
	);
	return painted
		.split(/\r?\n/)
		.flatMap((line, index) => (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(line) ? [index + 1] : []));
}

test('presentation scan skips nested .build output while retaining source CSS', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-design-tokens-'));
	try {
		const sources = ['source.css', 'code/.build.css', 'code/.build-tools/source.css'];
		const outputs = ['.build/assets/output.css', 'code/.build/assets/output.css'];
		for (const name of [...sources, ...outputs]) {
			const path = join(root, name);
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, '.sample { color: #ffffff; }');
		}
		assert.deepEqual((await presentationFiles(root)).sort(), sources.map(name => join(root, name)).sort());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function presentationFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name === '.build') continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await presentationFiles(path)));
		else if (entry.name.endsWith('.css') || (entry.name.endsWith('.ts') && !path.includes('/test/')))
			result.push(path);
	}
	return result;
}
