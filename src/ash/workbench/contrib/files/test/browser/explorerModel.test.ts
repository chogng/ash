import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { FileDragAndDrop } from '../../browser/views/explorerViewer.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IPathService } from '../../../../../platform/path/common/pathService.js';
import type { TreeDragData } from '../../../../../base/browser/ui/tree/tree.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { FileNotFoundError } from '../../../../../platform/files/common/files.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { FileKind, type IFileService } from '../../../../../platform/files/common/files.js';
import { ExplorerFileNestingSettingId } from '../../common/explorerFileNestingTrie.js';
import { ExplorerItem, ExplorerModel } from '../../common/explorerModel.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ExplorerDataSource, FileSorter } from '../../browser/views/explorerViewer.js';
import '../../browser/files.contribution.js';
import { SortOrder, LexicographicOptions } from '../../common/files.js';

test('Explorer hides default metadata entries at every depth and honors user overrides and resets', async () => {
	const root = URI.file('/project');
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using configuration = new TestConfigurationService();
	const directories = ['.git', '.svn', '.hg', '.jj', '.vscode', 'src'];
	const names = [...directories, '.DS_Store', 'Thumbs.db', '.gitignore', 'README.md'];
	const files = {
		readDirectory: async (resource: URI) => names.map(name => ({
			resource: URI.joinPath(resource, name),
			name,
			kind: directories.includes(name) ? FileKind.Directory : FileKind.File,
		})),
	} as unknown as IFileService;
	using source = new ExplorerDataSource(new FileSorter(configuration), files, configuration, workspace);
	const visibleNames = async (resource: URI) => (await source.getChildren(new ExplorerItem(resource, 'project', FileKind.Directory))).map(item => item.name);
	const visible = ['.vscode', 'src', '.gitignore', 'README.md'];
	for (const resource of [root, URI.joinPath(root, 'src', 'nested')]) {
		assert.deepEqual(await visibleNames(resource), visible);
	}

	await configuration.updateValue('files.exclude', { '**/.DS_Store': false, '**/README.md': true });
	assert.deepEqual(await visibleNames(root), ['.vscode', 'src', '.DS_Store', '.gitignore']);
	await configuration.updateValue('files.exclude', {});
	assert.deepEqual(await visibleNames(root), visible);
	await configuration.updateValue('files.exclude', { '**/.git': false });
	assert.deepEqual(await visibleNames(root), ['.git', '.vscode', 'src', '.gitignore', 'README.md']);
	await configuration.updateValue('files.exclude', undefined);
	assert.deepEqual(await visibleNames(root), visible);
});

test('Explorer applies exclusion conditions before nesting and reorders files when settings change', async () => {
	const root = URI.file('/project');
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using configuration = new InMemoryConfigurationService();
	const getValue = configuration.getValue.bind(configuration);
	configuration.getValue = ((section?: string) => section ? getValue(section) : getValue()) as typeof configuration.getValue;
	const entries = ['.git', 'folder', 'file10.ts', 'file2.ts', 'file2.js', 'file3.js', 'Upper.ts', 'lower.ts'].map(name => ({ resource: URI.joinPath(root, name), name, kind: name === '.git' || name === 'folder' ? FileKind.Directory : FileKind.File }));
	const files = {
		readDirectory: async () => entries,
		stat: async (resource: URI) => ({ resource, modifiedAtMillis: resource.path.includes('file2.ts') ? 20 : 10 }),
	} as unknown as IFileService;
	using source = new ExplorerDataSource(new FileSorter(configuration), files, configuration, workspace);
	const input = new ExplorerItem(root, 'project', FileKind.Directory);
	await configuration.updateValue('files.exclude', { '**/.git': true, '**/*.js': { when: '$(basename).ts' } });
	assert.deepEqual((await source.getChildren(input)).map(item => item.name), ['folder', 'file2.ts', 'file3.js', 'file10.ts', 'lower.ts', 'Upper.ts']);
	await configuration.updateValue('explorer.sortOrder', SortOrder.FilesFirst);
	assert.deepEqual((await source.getChildren(input)).map(item => item.name), ['file2.ts', 'file3.js', 'file10.ts', 'lower.ts', 'Upper.ts', 'folder']);
	await configuration.updateValue('explorer.sortOrder', SortOrder.Modified);
	assert.equal((await source.getChildren(input))[1]?.name, 'file2.ts');
	await configuration.updateValue('explorer.sortOrder', SortOrder.Type);
	assert.equal((await source.getChildren(input))[1]?.name, 'file3.js');
	await configuration.updateValue('explorer.sortOrder', SortOrder.Default);
	await configuration.updateValue('explorer.sortOrderLexicographicOptions', LexicographicOptions.Upper);
	assert.equal((await source.getChildren(input))[1]?.name, 'Upper.ts');
	await configuration.updateValue('explorer.sortOrderLexicographicOptions', LexicographicOptions.Unicode);
	assert.deepEqual((await source.getChildren(input)).map(item => item.name), ['folder', 'Upper.ts', 'file10.ts', 'file2.ts', 'file3.js', 'lower.ts']);
	await configuration.updateValue('explorer.sortOrderReverse', true);
	assert.deepEqual((await source.getChildren(input)).map(item => item.name), ['folder', 'lower.ts', 'file3.js', 'file2.ts', 'file10.ts', 'Upper.ts']);
	await configuration.updateValue('files.exclude', {});
	assert.ok((await source.getChildren(input)).some(item => item.name === '.git'));
});

test('Explorer model groups generated files and keeps directories as separate roots', async () => {
	const root = URI.file('C:\\project');
	const entries = [
		{ resource: URI.file('C:\\project\\main.ts'), name: 'main.ts', kind: FileKind.File },
		{ resource: URI.file('C:\\project\\main.js'), name: 'main.js', kind: FileKind.File },
		{ resource: URI.file('C:\\project\\src'), name: 'src', kind: FileKind.Directory },
		{ resource: URI.file('C:\\project\\link.js'), name: 'link.js', kind: FileKind.SymbolicLink },
		{ resource: URI.file('C:\\project\\unknown.pipe'), name: 'unknown.pipe', kind: FileKind.Other },
	];
	const files = { readDirectory: async () => entries } as unknown as IFileService;
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: ExplorerFileNestingSettingId.Enabled, defaultValue: false, parse: value => Boolean(value) });
	registry.registerConfiguration({ key: ExplorerFileNestingSettingId.Patterns, defaultValue: {}, parse: value => value as Record<string, string> });
	using configuration = new InMemoryConfigurationService(registry);
	await configuration.updateValue(ExplorerFileNestingSettingId.Enabled, true);
	await configuration.updateValue(ExplorerFileNestingSettingId.Patterns, { '*.ts': '${capture}.js' });
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	const getValue = configuration.getValue.bind(configuration);
	configuration.getValue = ((section?: string) => section ? getValue(section) : getValue()) as typeof configuration.getValue;
	using source = new ExplorerDataSource(new FileSorter(configuration), files, configuration, workspace);
	const children = await source.getChildren(new ExplorerItem(root, 'project', FileKind.Directory));
	assert.deepEqual(children.map(item => item.name), ['src', 'link.js', 'main.ts', 'unknown.pipe']);
	assert.deepEqual(children[2]?.children?.map(item => item.name), ['main.js']);
	assert.equal(children[2]?.children?.[0]?.resource.toString(), entries[1]?.resource.toString());
	assert.equal(children[1]?.kind, FileKind.SymbolicLink);
	assert.equal(children[3]?.kind, FileKind.Other);
	await configuration.updateValue(ExplorerFileNestingSettingId.Patterns, {});
	assert.deepEqual((await source.getChildren(new ExplorerItem(root, 'project', FileKind.Directory))).map(item => item.name), ['src', 'link.js', 'main.js', 'main.ts', 'unknown.pipe']);
});


test('Explorer drag policy moves a selection once, copies without overwrite, and imports exact bytes', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	setARIAContainer(browser.window.document.body);
	using browserLifetime = { [Symbol.dispose]: () => browser.window.close() };

	const root = URI.file('/project');
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using configuration = new InMemoryConfigurationService();
	const operations: string[] = [];
	const existing = new Set<string>();
	const errors: unknown[] = [];
	let confirmed = false;
	const files = {
		hasCapability: () => false,
		stat: async (uri: URI) => { if (!existing.has(uri.path)) throw new FileNotFoundError(uri); return { kind: FileKind.File }; },
		copy: async (source: URI, target: URI) => { operations.push(`copy ${source.path} ${target.path}`); existing.add(target.path); },
		rename: async (source: URI, target: URI) => { operations.push(`move ${source.path} ${target.path}`); existing.add(target.path); },
		writeFileBytes: async (target: URI, bytes: Uint8Array) => { operations.push(`bytes ${target.path} ${[...bytes].join(',')}`); },
	} as unknown as IFileService;
	using dnd = new FileDragAndDrop(error => errors.push(error), items => items, files, workspace, configuration, { confirm: async () => ({ confirmed }) } as unknown as IDialogService, { hasValidBasename: async (_uri, name) => name !== '..' } as IPathService);
	const folder = new ExplorerItem(root.joinPathSegment('folder'), 'folder', FileKind.Directory);
	const child = new ExplorerItem(folder.resource.joinPathSegment('child.txt'), 'child.txt', FileKind.File);
	const a = new ExplorerItem(root.joinPathSegment('a.txt'), 'a.txt', FileKind.File);
	const dest = new ExplorerItem(root.joinPathSegment('dest'), 'dest', FileKind.Directory);
	const data: TreeDragData<ExplorerItem> = { kind: 'internal', elements: [folder, child, a], types: [], files: [] };
	const move = { ctrlKey: false, altKey: false } as DragEvent;
	const copy = { ctrlKey: !isMacintosh, altKey: isMacintosh } as DragEvent;
	assert.equal(dnd.getDragURI(new ExplorerItem(root, 'root', FileKind.Directory)), undefined);
	assert.equal(dnd.onDragOver(data, folder, undefined, undefined, move), false);
	assert.equal(dnd.onDragOver(data, new ExplorerItem(child.resource.joinPathSegment('sub'), 'sub', FileKind.Directory), undefined, undefined, copy), false);
	dnd.drop(data, dest, undefined, undefined, move);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(operations, []);
	confirmed = true;
	dnd.drop(data, dest, undefined, undefined, move);
	await waitForEffects(() => operations.length === 2);
	assert.deepEqual(operations, ['move /project/folder /project/dest/folder', 'move /project/a.txt /project/dest/a.txt']);
	dnd.drop({ ...data, elements: [a] }, dest, undefined, undefined, copy);
	await waitForEffects(() => operations.length === 3);
	assert.equal(operations[2], 'copy /project/a.txt /project/dest/a copy.txt');
	const file = { name: 'binary.bin', arrayBuffer: async () => Uint8Array.from([0, 255, 239]).buffer } as File;
	dnd.drop({ kind: 'native', elements: [], types: ['Files'], files: [file] }, dest, undefined, undefined, move);
	await waitForEffects(() => operations.length === 4);
	assert.equal(operations[3], 'bytes /project/dest/binary.bin 0,255,239');
	await configuration.updateValue('explorer.enableDragAndDrop', false);
	assert.equal(dnd.onDragOver(data, dest, undefined, undefined, copy), false);
	assert.deepEqual(errors, []);
});

async function waitForEffects(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 1));
	}
	assert.fail('Timed out waiting for Explorer file operation');
}


test('a workspace file retains its visible root after shrinking to one folder', () => {
	const first = { id: 'one', uri: URI.file('/one'), name: 'One', index: 0 };
	const second = { id: 'two', uri: URI.file('/two'), name: 'Two', index: 1 };
	using workspace = new TestWorkspaceService({ id: 'team', configuration: URI.file('/team.ash-workspace'), folders: [first, second] });
	using model = new ExplorerModel(workspace);
	workspace.updateWorkspace({ ...workspace.getWorkspace(), folders: [first] });
	assert.equal(model.root?.resource.scheme, 'ash-workspace');
	assert.deepEqual(model.root?.children?.map(item => item.resource), [first.uri]);
	workspace.updateWorkspace({ id: 'one', uri: first.uri });
	assert.equal(model.root?.resource.toString(), first.uri.toString());
	assert.equal(model.root?.children, undefined);
});
