import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../base/common/uri.js';
import { WorkbenchThemesRegistry } from '../../../../common/theme.js';
import { loadUserThemes } from '../../browser/workbenchThemeService.js';
import { createExtensionWorkbenchColorTheme, parseExtensionTheme } from '../../../extensions/common/extensionTheme.js';
import { projectColorThemeTokens } from '../../../textMate/common/textMateThemeProjection.js';
import { parseUserColorTheme, serializeUserColorThemeDraft } from '../../common/colorThemeData.js';
import { colorThemeSchemaId, registerColorThemeSchemas } from '../../common/colorThemeSchema.js';
import { JsonSchemasRegistry } from '../../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { type WorkbenchThemeService } from '../../browser/workbenchThemeService.js';

const document = {
	name: 'Test User Aurora',
	type: 'dark',
	colors: { 'editor.background': '#101525', 'unsupported.extension.color': '#abcdef' },
	tokenColors: [{ scope: 'comment, string.quoted', settings: { foreground: '#123456', fontStyle: 'italic bold' } }],
};

test('user and extension themes share colors and TextMate rules', () => {
	const source = `// authored theme\n${JSON.stringify(document).replace(/}$/, ',}')}`;
	const user = parseUserColorTheme(source, 'test-user-aurora');
	const extension = createExtensionWorkbenchColorTheme(parseExtensionTheme(document, 'test-extension', 'test.theme', document.name, 'vs-dark', 'test'));
	assert.deepEqual(user.colors, extension.colors);
	assert.deepEqual(projectColorThemeTokens(user, 1), projectColorThemeTokens(extension, 1));
	assert.deepEqual(projectColorThemeTokens(user, 1).rules, [
		{ selector: 'comment', foreground: '#123456', fontStyle: ['italic', 'bold'] },
		{ selector: 'string.quoted', foreground: '#123456', fontStyle: ['italic', 'bold'] },
	]);
});

test('theme exports contain standard fields and resolved colors', () => {
	const source = serializeUserColorThemeDraft(lightColorTheme, 'Test Light Copy');
	const exported = JSON.parse(source);
	assert.deepEqual(Object.keys(exported), ['$schema', 'name', 'type', 'colors', 'tokenColors']);
	assert.equal(exported.type, 'light');
	assert.deepEqual(parseUserColorTheme(source).colors, lightColorTheme.colors);
	using registration = registerColorThemeSchemas();
	assert.ok(JsonSchemasRegistry.getSchema(colorThemeSchemaId)?.properties?.colors?.properties?.['editor.background']);
});

test('root theme extensions use the same document validator as user themes', async () => {
	const directory = join(process.cwd(), '../extensions/theme-defaults');
	const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	for (const contribution of manifest.contributes.themes) {
		const source = await readFile(join(directory, contribution.path), 'utf8');
		assert.ok(parseUserColorTheme(source, 'bundled-theme').getColorCss('editor.background'));
	}
});

test('current theme documents reject retired fields, transforms, and invalid token styles', () => {
	for (const value of [
		{ ...document, version: 1 },
		{ ...document, id: 'custom' },
		{ ...document, colors: { 'editor.background': 'red' } },
		{ ...document, colors: { 'editor.background': { op: 'lighten', value: '#000000', factor: 0.2 } } },
		{ ...document, tokenColors: [{ scope: 'comment', settings: { fontStyle: 'blink' } }] },
		{ ...document, include: './other.json' },
	]) assert.throws(() => parseUserColorTheme(JSON.stringify(value)), /Invalid color theme/);
});

test('theme file owner migrates aliases and transforms once before registration', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-migrate-'));
	try {
		const legacy = JSON.parse(await readFile(join(process.cwd(), 'src/ash/workbench/services/themes/test/browser/fixtures/resolver.json'), 'utf8'));
		await writeFile(join(directory, 'old-name.json'), JSON.stringify(legacy.theme));
		await writeFile(join(directory, 'broken.json'), '{');
		await writeFile(join(directory, 'ignored.txt'), 'keep');
		using files = new DiskFileSystemProvider([URI.file(directory)]);
		const service = await loadThemes(files, directory);
		const first = await files.readDirectory(URI.file(directory));
		const migrated = await readFile(join(directory, 'resolver-test.json'), 'utf8');
		const theme = parseUserColorTheme(migrated, 'resolver-test');
		for (const [key, value] of Object.entries(legacy.expected)) assert.equal(theme.getColorCss(key), value, key);
		assert.equal(JSON.parse(migrated).version, undefined);
		assert.deepEqual(await files.readDirectory(URI.file(directory)), first);
		try {
			assert.equal(WorkbenchThemesRegistry.getColorTheme('resolver-test')?.label, 'Resolver Test');
			assert.deepEqual(service.issues.map(issue => issue.file), ['broken.json']);
		} finally { service.dispose(); }
		assert.equal(WorkbenchThemesRegistry.getColorTheme('resolver-test'), undefined);
		assert.deepEqual((await readdir(directory)).sort(), ['broken.json', 'ignored.txt', 'resolver-test.json']);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('migration preserves conflicting targets and resumes after a durable equal target', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-conflict-'));
	try {
		const legacy = JSON.stringify({ version: 1, id: 'old-theme', label: 'Old Theme', colorScheme: 'dark', colors: { 'editor.background': '#123456' } });
		const source = join(directory, 'source.json');
		const target = join(directory, 'old-theme.json');
		await writeFile(source, legacy);
		await writeFile(target, JSON.stringify(document));
		using files = new DiskFileSystemProvider([URI.file(directory)]);
		const service = await loadThemes(files, directory);
		assert.match(service.issues.find(issue => issue.file === 'source.json')!.message, /conflicts/);
		service.dispose();
		assert.equal(await readFile(source, 'utf8'), legacy);
		assert.equal(await readFile(target, 'utf8'), JSON.stringify(document));
		await rm(target);
		(await loadThemes(files, directory)).dispose();
		const converted = await readFile(target, 'utf8');
		await writeFile(source, legacy);
		(await loadThemes(files, directory)).dispose();
		assert.equal((await files.readDirectory(URI.file(directory))).length, 1);
		assert.equal(await readFile(target, 'utf8'), converted);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('theme save, rename, reload, and delete keep identity in the filename', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-save-'));
	using files = new DiskFileSystemProvider([URI.file(directory)]);
	const service = await loadThemes(files, directory);
	try {
		const created = await service.saveAs(JSON.stringify(document));
		assert.equal(created.file, 'test-user-aurora.json');
		const replacement = JSON.stringify({ ...document, name: 'Renamed Theme', colors: { 'editor.background': '#202530' } });
		const saved = await service.save(created.theme.id, replacement);
		assert.equal(saved.theme.id, created.theme.id);
		assert.equal(saved.theme.label, 'Renamed Theme');
		assert.equal(saved.theme.getColorCss('editor.background'), '#202530');
		await service.reload();
		assert.equal(service.getSource(saved.theme.id), replacement);
		await service.delete(saved.theme.id);
		assert.equal(WorkbenchThemesRegistry.getColorTheme(saved.theme.id), undefined);
		assert.deepEqual(await readdir(directory), []);
	} finally { service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

async function loadThemes(files: IFileService, directory: string): Promise<WorkbenchThemeService> {
	using services = new ServiceContainer();
	services.registerInstance(IFileService, files);
	return loadUserThemes(services, URI.file(directory));
}
