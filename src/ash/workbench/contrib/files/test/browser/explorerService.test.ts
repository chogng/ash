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
		getContext: () => [selected],
		getAccessibleContent: () => 'main.ts',
		selectResource: async () => { },
		focus: () => { focused++; },
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

test('Explorer service owns roots and workspace file invalidations without a view', () => {
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
	using rootListener = service.onDidChangeRoot(() => observed.push(service.getRoot()?.resource.toString() ?? 'empty'));
	using fileListener = service.onDidChangeResources(resources => observed.push(resources?.[0]?.toString() ?? 'all'));

	changes.fire({ resources: [URI.file('/outside/file.txt'), URI.file('/project/main.ts')] });
	workspace.updateWorkspace({ id: 'next', uri: secondRoot });
	changes.fire({ resources: [URI.file('/project/main.ts'), URI.file('/next/other.ts')] });

	assert.deepEqual(observed, [URI.file('/project/main.ts').toString(), secondRoot.toString(), URI.file('/next/other.ts').toString()]);
	assert.deepEqual([...watches], [[secondRoot.toString(), { recursive: true, excludes: [] }]]);

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
	let selected: string | undefined;
	using registration = service.registerView({ selectResource: async resource => { selected = resource?.path; }, getContext: () => [], getAccessibleContent: () => '', focus() { } });
	await service.select(resource, 'force');
	assert.equal(selected, '/root/main.js');
	await configuration.updateValue('explorer.autoReveal', false);
	assert.equal(service.shouldAutoReveal(URI.file('/root/other.ts')), false);
});
