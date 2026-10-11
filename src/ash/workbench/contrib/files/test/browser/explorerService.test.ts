import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileKind, FileSystemProviderCapabilities, type IFileChangeEvent, type IWatchOptions } from '../../../../../platform/files/common/files.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { ExplorerItem } from '../../common/explorerModel.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('Explorer service exposes the current view and releases it on disposal', () => {
	using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	using configuration = new InMemoryConfigurationService();
	using files = new FileService();
	using service = new ExplorerService(workspace, files, configuration);
	const selected = new ExplorerItem(URI.file('/project/main.ts'), 'main.ts', FileKind.File);
	let focused = 0;
	assert.deepEqual(service.getContext(), []);
	assert.equal(service.getAccessibleContent(), undefined);
	const view = {
		refresh: async () => { },
		getContext: () => [selected],
		getAccessibleContent: () => 'main.ts',
		selectResource: async () => { },
		focus: () => { focused++; },
		hasFocus: () => focused > 0,
	};
	const registration = service.registerView(view);
	assert.deepEqual(service.getContext(), [selected]);
	assert.equal(service.getAccessibleContent(), 'main.ts');
	service.focus();
	assert.equal(focused, 1);
	assert.throws(() => service.registerView(view), /already registered/);
	registration.dispose();
	assert.deepEqual(service.getContext(), []);
	assert.equal(service.getAccessibleContent(), undefined);
	using next = service.registerView(view);
	assert.deepEqual(service.getContext(), [selected]);
});

test('Explorer service batches workspace file invalidations and discards pending changes on workspace switch', async () => {
	const firstRoot = URI.file('/project');
	const secondRoot = URI.file('/next');
	using workspace = new WorkspaceContextService({ id: 'project', uri: firstRoot });
	using changes = new Emitter<IFileChangeEvent>();
	using configuration = new InMemoryConfigurationService();
	using files = new FileService();
	const watches = new Map<string, IWatchOptions>();
	const unexpected = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
	using provider = files.registerProvider('file', {
		capabilities: FileSystemProviderCapabilities.FileReadWrite,
		onDidChangeCapabilities: Event.None,
		onDidChangeFiles: changes.event,
		watch: (resource, options) => {
			const key = resource.toString();
			watches.set(key, options);
			return toDisposable(() => { watches.delete(key); });
		},
		stat: unexpected, readDirectory: unexpected, readFile: unexpected, writeFile: unexpected,
		createFile: unexpected, createDirectory: unexpected, copy: unexpected, rename: unexpected, delete: unexpected,
	});
	using service = new ExplorerService(workspace, files, configuration);
	assert.equal(files.hasProvider(firstRoot), true);
	assert.deepEqual([...watches], [[firstRoot.toString(), { recursive: true, excludes: [] }]]);
	const observed: string[] = [];
	const batches: Array<readonly string[] | undefined> = [];
	let resolveChange = (): void => { };
	using rootListener = service.onDidChangeRoot(() => observed.push(service.getRoot()?.resource.toString() ?? 'empty'));
	using fileListener = service.onDidChangeResources(resources => {
		observed.push(resources?.[0]?.toString() ?? 'all');
		batches.push(resources?.map(resource => resource.path));
		resolveChange();
	});

	const firstChange = new Promise<void>(resolve => { resolveChange = resolve; });
	changes.fire({ resources: [URI.file('/outside/file.txt'), URI.file('/project/main.ts')] });
	changes.fire({ resources: [URI.file('/project/main.ts'), URI.file('/project/other.ts')] });
	assert.deepEqual(observed, []);
	await firstChange;
	assert.deepEqual(batches, [['/project/main.ts', '/project/other.ts']]);
	changes.fire({ resources: [URI.file('/project/stale.ts')] });
	workspace.updateWorkspace({ id: 'next', uri: secondRoot });
	const nextChange = new Promise<void>(resolve => { resolveChange = resolve; });
	changes.fire({ resources: [URI.file('/project/main.ts'), URI.file('/next/other.ts')] });
	await nextChange;

	assert.deepEqual(observed, [URI.file('/project/main.ts').toString(), secondRoot.toString(), URI.file('/next/other.ts').toString()]);
	assert.deepEqual([...watches], [[secondRoot.toString(), { recursive: true, excludes: [] }]]);
	const rescan = new Promise<void>(resolve => { resolveChange = resolve; });
	changes.fire({ resources: [URI.file('/next/other.ts')] });
	changes.fire({ resources: undefined });
	changes.fire({ resources: [URI.file('/next/another.ts')] });
	await rescan;
	assert.deepEqual(batches, [['/project/main.ts', '/project/other.ts'], ['/next/other.ts'], undefined]);

	const unavailableRoot = URI.parse('unavailable:/project');
	workspace.updateWorkspace({ id: 'unavailable', uri: unavailableRoot });
	assert.equal(files.hasProvider(unavailableRoot), false);
	assert.equal(service.getRoot()?.resource.toString(), unavailableRoot.toString());
	assert.deepEqual([...watches], []);

	workspace.updateWorkspace({ id: 'next', uri: secondRoot });
	assert.deepEqual([...watches], [[secondRoot.toString(), { recursive: true, excludes: [] }]]);
	service.dispose();
	assert.deepEqual([...watches], []);
	provider.dispose();
	assert.equal(files.hasProvider(secondRoot), false);
});

test('Explorer auto-reveal honors conditions and settings without changing manual selection', async () => {
	using workspace = new WorkspaceContextService({ id: 'root', uri: URI.file('/root') });
	using configuration = new InMemoryConfigurationService();
	using files = new FileService();
	using service = new ExplorerService(workspace, files, configuration);
	const resource = URI.file('/root/main.js');
	await configuration.updateValue('explorer.autoRevealExclude', { '**/*.js': { when: '$(basename).ts' } });
	assert.deepEqual([service.shouldAutoReveal(resource, name => name === 'main.ts'), service.shouldAutoReveal(resource, () => false)], [false, true]);
	await configuration.updateValue('explorer.autoRevealExclude', { '**/hidden': true });
	assert.deepEqual([service.shouldAutoReveal(URI.file('/root/hidden/nested/main.js')), service.shouldAutoReveal(URI.file('/root/visible/main.js'))], [false, true]);
	await configuration.updateValue('explorer.autoRevealExclude', { '**/root': true });
	assert.equal(service.shouldAutoReveal(resource), true);
	await configuration.updateValue('explorer.autoRevealExclude', { '**/*.js': { when: '$(basename).ts' } });
	let selected: string | undefined;
	using registration = service.registerView({ refresh: async () => { }, selectResource: async resource => { selected = resource?.path; }, getContext: () => [], getAccessibleContent: () => '', focus() { }, hasFocus: () => false });
	await service.select(resource, 'force');
	assert.equal(selected, '/root/main.js');
	await configuration.updateValue('explorer.autoReveal', false);
	assert.equal(service.shouldAutoReveal(URI.file('/root/other.ts')), false);
});
