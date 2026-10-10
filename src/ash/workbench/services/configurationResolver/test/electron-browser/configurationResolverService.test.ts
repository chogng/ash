import { createHash } from 'node:crypto';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { IExtensionService } from '../../../extensions/common/extensionService.js';
import { ConfigurationResolverExpression } from '../../common/configurationResolverExpression.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IRendererHostService } from '../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../../platform/agentHost/browser/rendererApi.js';
import { BrowserPathService } from '../../../path/browser/pathService.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../commands/common/commandService.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { WorkbenchQuickInputService } from '../../../quickinput/browser/quickInputService.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { MemoryFileService } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { IConfigurationResolverService } from '../../common/configurationResolver.js';
import '../../browser/configurationResolverService.js';

suite('ConfigurationResolverService', () => {
	for (const os of [OperatingSystem.Windows, OperatingSystem.Linux, OperatingSystem.Macintosh]) {
		test(`explicit environment resolution uses execution host case rules without acquiring host environment ${os}`, async () => {
			using workspace = new WorkspaceContextService({ id: 'environment', uri: URI.file('/work/project') });
			const base = createDisconnectedRendererApi();
			const host = { ...base, hasAppServer: true, appServer: { ...base.appServer, operatingSystem: os } };
			using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, host], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async () => { throw new Error('Explicit environment must not acquire host values'); } }]));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			const resolver = services.get(IConfigurationResolverService);
			const environment = Object.freeze({ Path: '${env:TARGET}', TARGET: 'chosen', ABSENT: undefined, EMPTY: '' });
			assert.equal(await resolver.resolveWithEnvironment(environment, undefined, '${env:Path}/${env:PATH}/${env:ABSENT}/${env:MISSING}/${env:EMPTY}/${command:untouched}'), os === OperatingSystem.Windows ? 'chosen/chosen////${command:untouched}' : 'chosen/////${command:untouched}');
			assert.deepEqual(environment, { Path: '${env:TARGET}', TARGET: 'chosen', ABSENT: undefined, EMPTY: '' });
		});
	}

	test('interaction maps and replacements share contributed variable caching, nested resolution and cancellation', async () => {
		using workspace = new WorkspaceContextService({ id: 'variables', uri: URI.file('/work/project') });
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async () => ({}) }]));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		const resolver = services.get(IConfigurationResolverService);
		const folder = workspace.getWorkspace().folders[0];
		let calls = 0;
		resolver.contributeVariable('target:pick', async () => { calls++; return '${workspaceFolderBasename}'; });
		resolver.contributeVariable('target:cancel', async () => undefined);
		assert.equal(resolver.resolvableVariables.has('target:pick'), true);
		assert.equal(await resolver.resolveAsync(folder, '${target:pick}'), '${target:pick}');
		assert.equal(calls, 0);
		using command = CommandsRegistry.register('resolver.contribution.command', () => '${target:pick}');
		const source = Object.freeze({ program: '${target:pick}', args: Object.freeze(['${target:pick}', '${command:alias}', '${unknown}']) });
		assert.deepEqual(await resolver.resolveWithInteractionReplace(folder, source, undefined, { alias: 'resolver.contribution.command' }), { program: 'project', args: ['project', 'project', '${unknown}'] });
		assert.equal(calls, 1);
		assert.deepEqual(await resolver.resolveWithInteraction(folder, source, undefined, { alias: 'resolver.contribution.command' }), new Map([['target:pick', '${workspaceFolderBasename}'], ['workspaceFolderBasename', 'project'], ['command:alias', '${target:pick}']]));
		assert.equal(calls, 2);
		assert.equal(await resolver.resolveWithInteraction(folder, '${target:cancel}'), undefined);
		assert.equal(await resolver.resolveWithInteractionReplace(folder, '${target:cancel}'), undefined);
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		assert.throws(() => resolver.contributeVariable('target:pick', async () => 'replacement'), { message: '变量“target:pick”被重复注册。' });
		assert.equal(source.program, '${target:pick}');
	});

	test('workspace retirement cancels a pending contributed variable before a later command runs', async () => {
		using workspace = new WorkspaceContextService({ id: 'variables', uri: URI.file('/work/project') });
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async () => ({}) }]));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		const resolver = services.get(IConfigurationResolverService);
		const entered = new DeferredPromise<void>();
		const finish = new DeferredPromise<string>();
		resolver.contributeVariable('pendingTarget', () => { void entered.complete(undefined); return finish.p; });
		let commands = 0;
		using command = CommandsRegistry.register('resolver.contribution.later', () => { commands++; return 'late'; });
		const pending = resolver.resolveWithInteraction(undefined, ['${pendingTarget}', '${command:resolver.contribution.later}']);
		await entered.p;
		workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
		assert.equal(await pending, undefined);
		void finish.complete('retired');
		assert.equal(commands, 0);
	});

	for (const key of ['resolverInputs', 'resolverInputs.inputs']) {
		test(`configured inputs select the canonical default or user scope through the public target argument for ${key}`, async () => {
			using resources = new DisposableStore();
			using workspace = new WorkspaceContextService({ id: 'inputs', uri: URI.file('/work/project') });
			const registry = new ConfigurationRegistry();
			const wrap = (command: string) => key.endsWith('.inputs') ? [{ id: 'target', type: 'command', command }] : { inputs: [{ id: 'target', type: 'command', command }] };
			registry.registerConfiguration({ key, defaultValue: wrap('resolver.inputs.default'), parse: value => value });
			const configuration = resources.add(new WorkbenchConfigurationService({ registry }));
			await configuration.updateValue(key, wrap('resolver.inputs.user'), ConfigurationTarget.USER);
			const files = resources.add(createTestFileService(new MemoryFileService([])));
			using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, configuration], [IWorkspaceContextService, workspace], [IFileService, files], [IQuickInputService, {}], [ITerminalProcessService, { getEnvironment: async () => ({}) }]));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			using commands = CommandsRegistry.registerMany([{ id: 'resolver.inputs.default', handler: () => 'default-target' }, { id: 'resolver.inputs.user', handler: () => 'user-target' }]);
			const resolver = services.get(IConfigurationResolverService);
			assert.deepEqual(await resolver.resolveWithInteractionReplace(undefined, { program: '${input:target}' }, 'resolverInputs', undefined, ConfigurationTarget.DEFAULT), { program: 'default-target' });
			assert.deepEqual(await resolver.resolveWithInteraction(undefined, '${input:target}', 'resolverInputs', undefined, ConfigurationTarget.USER), new Map([['input:target', 'user-target']]));
		});
	}

	for (const resource of [URI.file('/work/project folder'), URI.from({ scheme: Schemas.file, path: '/C:/work/project folder' }), createSshRemoteWorkspaceUri('build', '/srv/project folder')]) {
		test(`resolves nested execution data without mutating configuration for ${resource.scheme}:${resource.path}`, async () => {
			using workspace = new WorkspaceContextService({ id: 'test', uri: resource });
			using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			const resolver = services.get(IConfigurationResolverService);
			const input = Object.freeze({ program: '${workspaceFolder}/app', args: Object.freeze(['${workspaceFolderBasename}', '${workspaceFolder} ${workspaceFolder}', '${unknown}', '${command:run}']), nested: Object.freeze({ cwd: '${workspaceFolder}', count: 3, enabled: false, empty: null }) });
			const path = resource.scheme === Schemas.file ? resource.fsPath : resource.path;
			assert.deepEqual(await resolver.resolveAsync(workspace.getWorkspace().folders[0], input), {
				program: `${path}/app`, args: ['project folder', `${path} ${path}`, '${unknown}', '${command:run}'], nested: { cwd: path, count: 3, enabled: false, empty: null },
			});
			assert.equal(input.nested.cwd, '${workspaceFolder}');
			assert.deepEqual(await resolver.resolveAsync(workspace.getWorkspace().folders[0], ['${workspaceRoot}', '${workspaceRootFolderName}']), [path, 'project folder']);
			assert.deepEqual([...resolver.resolvableVariables], ['workspaceFolder', 'workspaceFolderBasename', 'workspaceRoot', 'workspaceRootFolderName', 'env', 'command', 'input', 'config', 'userHome', 'cwd', 'pathSeparator', '/', 'file', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname', 'fileDirname', 'fileDirnameBasename', 'fileExtname', 'fileBasename', 'fileBasenameNoExtension', 'selectedText', 'lineNumber', 'columnNumber', 'extensionInstallFolder']);
		});
	}

	for (const os of [OperatingSystem.Linux, OperatingSystem.Windows]) {
		test(`resolves installed extension locations on the execution host and retires catalog entries (${os})`, async () => {
			using owner = new DisposableStore();
			using workspace = new WorkspaceContextService({ id: 'test' });
			const base = createDisconnectedRendererApi();
			const host = { ...base, hasAppServer: true, appServer: { ...base.appServer, operatingSystem: os } };
			using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, host], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			const location = os === OperatingSystem.Windows ? URI.from({ scheme: Schemas.file, path: '/C:/Extensions/installed folder' }) : URI.file('/extensions/installed folder');
			const manifestJson = JSON.stringify({ name: 'fixture', publisher: 'acme', version: '1.0.0' });
			const extension = { id: 'acme.fixture', name: 'fixture', publisher: 'acme', version: '1.0.0', displayName: 'Fixture', sourceKind: 'plugin' as const, extensionLocation: location.toString(), manifestJson, manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`, packageSha256: `sha256:${'b'.repeat(64)}` };
			let enabled = true;
			let scans = 0;
			const extensions = owner.add(new TestExtensionService({ list: async () => ({ generation: ++scans, extensions: enabled ? [extension] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('No resource acquisition expected'); }) }));
			services.registerInstance(IExtensionService, extensions);
			const resolver = services.get(IConfigurationResolverService);
			const expected = os === OperatingSystem.Windows ? 'C:\\Extensions\\installed folder' : '/extensions/installed folder';
			assert.deepEqual(await resolver.resolveAsync(undefined, { program: '${extensionInstallFolder:ACME.FIXTURE}', args: ['${extensionInstallFolder:acme.fixture}'] }), { program: expected, args: [expected] });
			assert.equal(scans, 1, 'repeated references borrow the current catalog without rescanning');
			assert.equal((await extensions.getExtension('Acme.Fixture'))?.extensionLocation?.toString(), location.toString());
			enabled = false;
			await extensions.reload();
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization('zh-CN');
			await assert.rejects(resolver.resolveAsync(undefined, '${extensionInstallFolder:acme.fixture}'), { message: '无法解析扩展“acme.fixture”：其安装目录不可用。' });
			assert.equal(scans, 2);
		});
	}

	test('cancels pending extension catalog acquisition before a command variable can run', async () => {
		using owner = new DisposableStore();
		using workspace = new WorkspaceContextService({ id: 'before', uri: URI.file('/before') });
		using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		const entered = new DeferredPromise<void>();
		const catalog = new DeferredPromise<{ generation: number; extensions: []; diagnostics: []; }>();
		const extensions = owner.add(new TestExtensionService({ list: () => { void entered.complete(undefined); return catalog.p; }, resources: new ExtensionResourceLoaderService(async () => { throw new Error('No resource acquisition expected'); }) }));
		services.registerInstance(IExtensionService, extensions);
		let calls = 0;
		using command = CommandsRegistry.register('resolver.test.afterExtensions', () => { calls++; return 'started'; });
		const pending = services.get(IConfigurationResolverService).resolveWithInteractionReplace(workspace.getWorkspace().folders[0], '${extensionInstallFolder:acme.fixture} ${command:resolver.test.afterExtensions}');
		await entered.p;
		workspace.updateWorkspace({ id: 'after', uri: URI.file('/after') });
		assert.equal(await pending, undefined);
		void catalog.complete({ generation: 1, extensions: [], diagnostics: [] });
		await extensions.getExtension('acme.fixture');
		assert.equal(calls, 0);
	});

	test('uses folder names for selectors and reads the current workspace at each call', async () => {
		let folders: readonly IWorkspaceFolder[] = [{ id: 'server', uri: createSshRemoteWorkspaceUri('build', '/srv/server'), name: 'Server', index: 0 }];
		const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'test', folders }), getWorkbenchState: () => 2, getWorkspaceFolder: () => null };
		using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		const resolver = services.get(IConfigurationResolverService);
		assert.equal(await resolver.resolveAsync(undefined, '${workspaceFolder:Server}/${workspaceFolderBasename:Server}'), '/srv/server/server');
		assert.equal(await resolver.resolveAsync(undefined, '${workspaceRoot:Server}/${workspaceRootFolderName:Server}'), '/srv/server/server');
		folders = [{ ...folders[0]!, uri: createSshRemoteWorkspaceUri('build', '/srv/new') }];
		assert.equal(await resolver.resolveAsync(undefined, '${workspaceFolder:Server}'), '/srv/new');
		await assert.rejects(resolver.resolveAsync(undefined, '${workspaceFolder:Missing}'));
	});

	test('reports missing folders in the selected language and allows folderless literal configurations', async () => {
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		using workspace = new WorkspaceContextService({ id: 'empty' });
		using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		const resolver = services.get(IConfigurationResolverService);
		assert.equal(await resolver.resolveAsync(undefined, 'adapter'), 'adapter');
		await assert.rejects(resolver.resolveAsync(undefined, '${workspaceFolder}'), { message: '无法解析“workspaceFolder”：请打开或选择所引用的工作区文件夹。' });
	});

	test('requires the workspace service when the registered resolver is instantiated', () => {
		using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors()));
		assert.throws(() => services.get(IConfigurationResolverService).resolveAsync(undefined, ''), /Unknown service: workspaceContextService/);
	});

	test('requires the command service before the registered resolver can resolve configuration', () => {
		using workspace = new WorkspaceContextService({ id: 'test' });
		using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
		assert.throws(() => services.get(IConfigurationResolverService).resolveAsync(undefined, ''), /Unknown service: commandService/);
	});
});

test('ConfigurationResolverService resolves each command reference once per invocation with resolved configuration and aliases', async () => {
	using workspace = new WorkspaceContextService({ id: 'test', uri: URI.file('/project') });
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	const seen: unknown[] = [];
	using command = CommandsRegistry.register('resolver.test.value', (_accessor, config) => {
		seen.push(config);
		return `value-${seen.length}-${'${workspaceFolder}'}`;
	});
	const source = { cwd: '${workspaceFolder}', values: ['${command:alias}', '${command:alias}/${command:resolver.test.value}'] };
	const resolver = services.get(IConfigurationResolverService);
	const folder = workspace.getWorkspace().folders[0];
	assert.deepEqual(await resolver.resolveWithInteractionReplace(folder, source, 'launch', { alias: 'resolver.test.value' }), { cwd: '/project', values: ['value-1-/project', 'value-1-/project/value-2-/project'] });
	assert.deepEqual(seen, [{ ...source, cwd: '/project' }, { ...source, cwd: '/project' }]);
	assert.equal(source.cwd, '${workspaceFolder}');
	assert.deepEqual(await resolver.resolveWithInteractionReplace(folder, '${command:resolver.test.value} ${command:resolver.test.value}'), 'value-3-/project value-3-/project');
});

test('ConfigurationResolverService rejects non-string command results in the selected language and stops on cancellation', async () => {
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	using workspace = new WorkspaceContextService({ id: 'test' });
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	let later = 0;
	using commands = CommandsRegistry.registerMany([
		{ id: 'resolver.test.invalid', handler: () => 7 },
		{ id: 'resolver.test.cancel', handler: () => undefined },
		{ id: 'resolver.test.later', handler: () => { later++; return ''; } },
	]);
	const resolver = services.get(IConfigurationResolverService);
	await assert.rejects(resolver.resolveWithInteractionReplace(undefined, '${command:resolver.test.invalid}'), { message: '命令“resolver.test.invalid”必须返回字符串，才能解析配置变量。' });
	assert.equal(await resolver.resolveWithInteractionReplace(undefined, '${command:resolver.test.cancel}/${command:resolver.test.later}'), undefined);
	assert.equal(later, 0);
	assert.equal(await resolver.resolveWithInteractionReplace(undefined, '${command:resolver.test.later}'), '');
});

test('ConfigurationResolverService stops pending interactions when the workspace changes', async () => {
	using workspace = new WorkspaceContextService({ id: 'test', uri: URI.file('/before') });
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<string>();
	let later = 0;
	using commands = CommandsRegistry.registerMany([
		{ id: 'resolver.test.pending', handler: () => { void entered.complete(undefined); return finish.p; } },
		{ id: 'resolver.test.later', handler: () => { later++; return 'later'; } },
	]);
	const pending = services.get(IConfigurationResolverService).resolveWithInteractionReplace(workspace.getWorkspace().folders[0], '${command:resolver.test.pending} ${command:resolver.test.later}');
	await entered.p;
	workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/after') });
	void finish.complete('pending');
	assert.equal(await pending, undefined);
	assert.equal(later, 0);
});

test('ConfigurationResolverService preserves backslashes in Remote folder basenames', async () => {
	using workspace = new WorkspaceContextService({ id: 'test', uri: createSshRemoteWorkspaceUri('build', '/srv/project\\folder') });
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	const resolver = services.get(IConfigurationResolverService);
	assert.equal(await resolver.resolveAsync(workspace.getWorkspace().folders[0], '${workspaceFolderBasename}'), 'project\\folder');
});

function inputServices(owner: DisposableStore, workspace: IWorkspaceContextService, contents: readonly (readonly [URI, string])[]): { services: InstantiationService; document: Document; press: (key: string) => void; } {
	const dom = new JSDOM('<!doctype html><body><button>Editor</button></body>');
	owner.add(toDisposable(() => dom.window.close()));
	for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator'] as const) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
		owner.add(toDisposable(() => {
			if (previous) Object.defineProperty(globalThis, name, previous);
			else Reflect.deleteProperty(globalThis, name);
		}));
	}
	const document = dom.window.document;
	const context = owner.add(new ContextKeyService());
	const quickInput = owner.add(new WorkbenchQuickInputService({ container: document.body, contextKeyService: context }));
	const services = owner.add(new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)],
		...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace],
		[IFileService, owner.add(createTestFileService(new MemoryFileService(contents)))], [IQuickInputService, quickInput],
	)));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	return { services, document, press: key => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) };
}

async function waitForPrompt(document: Document, label?: string): Promise<HTMLInputElement> {
	for (let attempts = 0; attempts < 100; attempts++) {
		const input = document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
		if (input && (label === undefined || input.getAttribute('aria-label') === label)) return input;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw new Error('Configured input did not open');
}

for (const resource of [URI.file('/inputs'), createSshRemoteWorkspaceUri('build', '/srv/inputs')]) {
	test(`ConfigurationResolverService resolves prompt and pick inputs from ${resource.scheme} with defaults, nested replacement results and keyboard focus`, async () => {
		using owner = new DisposableStore();
		using workspace = new WorkspaceContextService({ id: 'inputs', uri: resource });
		const inputs = [
			{ id: 'name', type: 'promptString', description: 'Project name', default: 'before', password: true },
			{ id: 'mode', type: 'pickString', description: 'Build mode', options: ['debug', { label: 'Optimized', value: 'release' }], default: 'release' },
		];
		const { services, document, press } = inputServices(owner, workspace, [[URI.joinPath(resource, '.vscode/tasks.json'), JSON.stringify({ inputs })]]);
		const editor = document.querySelector('button')!;
		editor.focus();
		const source = { command: '${input:name}/${input:mode}/${input:name}' };
		const pending = services.get(IConfigurationResolverService).resolveWithInteractionReplace(workspace.getWorkspace().folders[0], source, 'tasks');
		const prompt = await waitForPrompt(document);
		assert.equal(document.activeElement, prompt);
		assert.equal(prompt.value, 'before');
		assert.equal(prompt.type, 'password');
		assert.equal(prompt.getAttribute('aria-label'), 'Project name');
		prompt.value = '${workspaceFolder}';
		press('Enter');
		const pick = await waitForPrompt(document, 'Build mode');
		assert.equal(pick.getAttribute('aria-label'), 'Build mode');
		assert.equal(document.querySelector('[role="option"]')?.textContent, 'Optimized');
		press('Enter');
		assert.deepEqual(await pending, { command: `${resource.path}/release/${resource.path}` });
		assert.deepEqual(source, { command: '${input:name}/${input:mode}/${input:name}' });
		assert.equal(document.activeElement, editor);
		assert.equal(document.querySelector('.ash-quick-pick'), null);
	});
}

test('ConfigurationResolverService scopes command inputs to launch.json and reevaluates each invocation with declared args', async () => {
	using owner = new DisposableStore();
	using workspace = new WorkspaceContextService({ id: 'inputs', uri: URI.file('/inputs') });
	const root = workspace.getWorkspace().folders[0]!;
	const { services } = inputServices(owner, workspace, [
		[URI.joinPath(root.uri, '.vscode/launch.json'), JSON.stringify({ inputs: [{ id: 'value', type: 'command', command: 'resolver.test.input', args: { selection: 'launch' } }] })],
		[URI.joinPath(root.uri, '.vscode/tasks.json'), JSON.stringify({ inputs: [{ id: 'value', type: 'command', command: 'resolver.test.input', args: { selection: 'tasks' } }] })],
	]);
	const seen: unknown[] = [];
	using command = CommandsRegistry.register('resolver.test.input', (_accessor, args) => { seen.push(args); return String(seen.length); });
	const resolver = services.get(IConfigurationResolverService);
	assert.equal(await resolver.resolveWithInteractionReplace(root, '${input:value}/${input:value}', 'launch'), '1/1');
	assert.equal(await resolver.resolveWithInteractionReplace(root, '${input:value}', 'launch'), '2');
	assert.equal(await resolver.resolveWithInteractionReplace(root, '${input:value}', 'tasks'), '3');
	assert.deepEqual(seen, [{ selection: 'launch' }, { selection: 'launch' }, { selection: 'tasks' }]);
});

for (const cancellation of ['escape', 'workspace', 'dispose', 'pick'] as const) {
	test(`ConfigurationResolverService cancels ${cancellation} input and never invokes later commands`, async () => {
		using owner = new DisposableStore();
		using workspace = new WorkspaceContextService({ id: 'inputs', uri: URI.file('/inputs') });
		const folder = workspace.getWorkspace().folders[0]!;
		const input = cancellation === 'pick'
			? { id: 'value', type: 'pickString', description: 'Value', options: ['one'] }
			: { id: 'value', type: 'promptString', description: 'Value' };
		const { services, document, press } = inputServices(owner, workspace, [[URI.joinPath(folder.uri, '.vscode/tasks.json'), JSON.stringify({ inputs: [input] })]]);
		let called = false;
		using command = CommandsRegistry.register('resolver.test.afterInput', () => { called = true; return 'late'; });
		const resolver = services.get(IConfigurationResolverService);
		const pending = resolver.resolveWithInteractionReplace(folder, '${input:value}/${command:resolver.test.afterInput}', 'tasks');
		await waitForPrompt(document);
		if (cancellation === 'workspace' || cancellation === 'pick') workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/other') });
		else if (cancellation === 'dispose') services.dispose();
		else press('Escape');
		assert.equal(await pending, undefined);
		assert.equal(called, false);
		assert.equal(document.querySelector('.ash-quick-pick'), null);
	});
}

test('ConfigurationResolverService validates referenced input definitions before any interaction or command', async () => {
	using owner = new DisposableStore();
	using workspace = new WorkspaceContextService({ id: 'inputs', uri: URI.file('/inputs') });
	const folder = workspace.getWorkspace().folders[0]!;
	const { services, document } = inputServices(owner, workspace, [[URI.joinPath(folder.uri, '.vscode/tasks.json'), JSON.stringify({
		inputs: [
			{ id: 'duplicate', type: 'command', command: 'resolver.test.early' },
			{ id: 'duplicate', type: 'command', command: 'resolver.test.early' },
			{ id: 'invalid', type: 'pickString', description: 'Invalid', options: [{ label: 'Missing value' }] },
		]
	})]]);
	let called = false;
	using command = CommandsRegistry.register('resolver.test.early', () => { called = true; return 'early'; });
	const resolver = services.get(IConfigurationResolverService);
	for (const id of ['missing', 'duplicate', 'invalid']) {
		await assert.rejects(resolver.resolveWithInteractionReplace(folder, '${command:resolver.test.early}/${input:' + id + '}', 'tasks'), /must have one valid definition/);
	}
	assert.equal(called, false);
	assert.equal(document.querySelector('.ash-quick-pick'), null);
});

test('ConfigurationResolverService retires a pending configured command on workspace change without waiting for its producer', async () => {
	using owner = new DisposableStore();
	using workspace = new WorkspaceContextService({ id: 'inputs', uri: URI.file('/inputs') });
	const folder = workspace.getWorkspace().folders[0]!;
	const { services } = inputServices(owner, workspace, [[URI.joinPath(folder.uri, '.vscode/tasks.json'), JSON.stringify({ inputs: [{ id: 'pending', type: 'command', command: 'resolver.test.pendingInput' }] })]]);
	const entered = new DeferredPromise<void>();
	const result = new DeferredPromise<string>();
	using command = CommandsRegistry.register('resolver.test.pendingInput', () => { void entered.complete(undefined); return result.p; });
	const pending = services.get(IConfigurationResolverService).resolveWithInteractionReplace(folder, '${input:pending}', 'tasks');
	await entered.p;
	workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/other') });
	assert.equal(await pending, undefined);
	void result.complete('late');
});


test('ConfigurationResolverService reads selected Remote environment once and resolves nested command references once', async () => {
	const folder: IWorkspaceFolder = { id: 'server', name: 'Server', uri: createSshRemoteWorkspaceUri('build', '/srv/project'), index: 1 };
	const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'remote', folders: [{ ...folder, id: 'client', name: 'Client', uri: createSshRemoteWorkspaceUri('build', '/srv/client'), index: 0 }, folder] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => folder };
	const reads: unknown[] = [];
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [IWorkspaceContextService, workspace], [ITerminalProcessService, {
		getEnvironment: async (names: readonly string[], dirId?: string) => {
			reads.push({ names, dirId });
			return { HOME: '/remote/home', LANG: '${command:resolver.test.env}' };
		},
	}]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	let calls = 0;
	using command = CommandsRegistry.register('resolver.test.env', () => { calls++; return 'literal'; });
	const source = Object.freeze({ cwd: '${env:HOME}', args: ['${env:HOME}', '${env:MISSING}', '${env:LANG}', '${command:resolver.test.env}'] });
	assert.deepEqual(await services.get(IConfigurationResolverService).resolveWithInteractionReplace(folder, source), {
		cwd: '/remote/home', args: ['/remote/home', '', 'literal', 'literal'],
	});
	assert.deepEqual(reads, [{ names: ['HOME', 'MISSING', 'LANG'], dirId: folder.id }]);
	assert.equal(calls, 1);
	assert.equal(source.cwd, '${env:HOME}');
});

test('ConfigurationResolverService cancels pending host lookup before executing command variables', async () => {
	using workspace = new WorkspaceContextService({ id: 'before', uri: URI.file('/before') });
	const entered = new DeferredPromise<void>();
	const environment = new DeferredPromise<Readonly<Record<string, string>>>();
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [IWorkspaceContextService, workspace], [ITerminalProcessService, {
		getEnvironment: () => { void entered.complete(undefined); return environment.p; },
	}]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	let calls = 0;
	using command = CommandsRegistry.register('resolver.test.afterEnvironment', () => { calls++; return 'started'; });
	const pending = services.get(IConfigurationResolverService).resolveWithInteractionReplace(workspace.getWorkspace().folders[0], '${env:HOME} ${command:resolver.test.afterEnvironment}');
	await entered.p;
	workspace.updateWorkspace({ id: 'after', uri: URI.file('/after') });
	assert.equal(await pending, undefined);
	void environment.complete({ HOME: '/old' });
	assert.equal(calls, 0);
});

test('ConfigurationResolverService validates environment names in the selected language', async () => {
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	using workspace = new WorkspaceContextService({ id: 'test' });
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], ...getSingletonServiceDescriptors(), [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	await assert.rejects(services.get(IConfigurationResolverService).resolveAsync(undefined, '${env:}'), { message: '必须提供环境变量名称。' });
});

test('execution variables use the Windows host paths and scalar configuration snapshot across command substitution', async () => {
	using resources = new DisposableStore();
	using workspace = new WorkspaceContextService({ id: 'windows', uri: URI.from({ scheme: Schemas.file, path: '/c:/work/project' }) });
	const registry = new ConfigurationRegistry();
	for (const [key, defaultValue] of Object.entries({ 'resolver.text': '${env:HOME}', 'resolver.number': 0, 'resolver.boolean': false, 'resolver.structured': { value: 1 } })) registry.registerConfiguration({ key, defaultValue, parse: value => value });
	const configuration = resources.add(new WorkbenchConfigurationService({ registry }));
	const base = createDisconnectedRendererApi();
	const host = { ...base, hasAppServer: true, appServer: { ...base.appServer, operatingSystem: OperatingSystem.Windows, userHome: 'c:\\Users\\Build' } };
	using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, host], [IConfigurationService, configuration], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async () => ({ HOME: 'environment' }) }]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	const seen: unknown[] = [];
	using command = CommandsRegistry.register('resolver.test.hostSnapshot', (_accessor, value) => { seen.push(value); return '${config:resolver.number}'; });
	const resolver = services.get(IConfigurationResolverService);
	const source = { cwd: '${cwd}', folder: '${workspaceFolder}', name: '${workspaceFolderBasename}', home: '${userHome}', separator: '${pathSeparator}${/}', text: '${config:resolver.text}', number: '${config:resolver.number}', boolean: '${config:resolver.boolean}', callback: '${command:resolver.test.hostSnapshot}' };
	const resolved = { cwd: 'C:\\work\\project', folder: 'C:\\work\\project', name: 'project', home: 'C:\\Users\\Build', separator: '\\\\', text: 'environment', number: '0', boolean: 'false', callback: '0' };
	assert.deepEqual(await resolver.resolveWithInteractionReplace(workspace.getWorkspace().folders[0], source), resolved);
	assert.deepEqual(seen, [{ ...resolved, callback: '${command:resolver.test.hostSnapshot}' }]);
	await configuration.updateValue('resolver.number', 7);
	assert.equal(await resolver.resolveAsync(workspace.getWorkspace().folders[0], '${config:resolver.number}'), '7');
	const share = URI.from({ scheme: Schemas.file, authority: 'build', path: '/share/project' });
	assert.equal(await resolver.resolveAsync({ uri: share, name: 'Share' }, '${workspaceFolder}'), '\\\\build\\share\\project');
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	await assert.rejects(resolver.resolveAsync(undefined, '${config:resolver.structured}'), { message: '无法解析配置“resolver.structured”：其值必须是字符串、数字或布尔值。' });
	await assert.rejects(resolver.resolveAsync(undefined, '${config:missing}'), { message: '无法解析配置“missing”：其值必须是字符串、数字或布尔值。' });
});

test('execution home uses host facts and rejects missing facts instead of deriving home from the workspace', async () => {
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const base = createDisconnectedRendererApi();
	const host = { ...base, hasAppServer: true, appServer: { ...base.appServer, operatingSystem: OperatingSystem.Linux } };
	using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, host], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async () => ({}) }]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	const resolver = services.get(IConfigurationResolverService);
	await assert.rejects(resolver.resolveAsync(workspace.getWorkspace().folders[0], '${userHome}'), { message: '执行主机的用户主目录不可用。' });
	assert.equal(await resolver.resolveAsync(workspace.getWorkspace().folders[0], '${cwd}${/}src'), '/workspace/src');
});

test('configuration expressions substitute keys and nested values regardless of resolution order while retaining callable ownership', () => {
	const callback = (): string => 'callback';
	const source = Object.freeze({ env: Object.freeze({ '${input:key}': '${input:value}' }), callback });
	const expression = ConfigurationResolverExpression.parse(source);
	const original = [...expression.unresolved()];
	expression.resolve(original.find(reference => reference.arg === 'value')!, '${env:NAME}');
	expression.resolve(original.find(reference => reference.arg === 'key')!, 'ASH_${env:NAME}');
	for (const reference of expression.unresolved()) expression.resolve(reference, 'target');
	assert.deepEqual(expression.toObject(), { env: { ASH_target: 'target' }, callback });
	assert.deepEqual(source.env, { '${input:key}': '${input:value}' });
	assert.deepEqual([...expression.resolved()].map(([reference, data]) => [reference.inner, data.value]), [['input:value', '${env:NAME}'], ['input:key', 'ASH_${env:NAME}'], ['env:NAME', 'target']]);
});

test('configuration expressions retain a balanced outer variable argument and leave recursive references finite', () => {
	const expression = ConfigurationResolverExpression.parse('${env:HOME${env:USER}}/${env:HOME}');
	assert.deepEqual([...expression.unresolved()], [{ id: '${env:HOME${env:USER}}', inner: 'env:HOME${env:USER}', name: 'env', arg: 'HOME${env:USER}' }, { id: '${env:HOME}', inner: 'env:HOME', name: 'env', arg: 'HOME' }]);
	const cyclic = ConfigurationResolverExpression.parse('${command:first}');
	for (const reference of cyclic.unresolved()) cyclic.resolve(reference, reference.arg === 'first' ? '${command:second}' : '${command:first}');
	assert.equal(cyclic.toObject(), '${command:first}');
});

test('the real resolver follows nested host and configuration references in keys and values with one evaluation per name', async () => {
	using resources = new DisposableStore();
	using workspace = new WorkspaceContextService({ id: 'nested', uri: URI.file('/nested') });
	const registry = new ConfigurationRegistry();
	for (const [key, defaultValue] of Object.entries({ 'nested.a': 'A=${config:nested.b}', 'nested.b': '${env:REDIRECTED}', 'nested.cycle': '${config:nested.cycle}' })) registry.registerConfiguration({ key, defaultValue, parse: value => value });
	const configuration = resources.add(new WorkbenchConfigurationService({ registry }));
	const hostValues: Record<string, string> = { USER: '${env:FINAL}', FINAL: 'target', REDIRECTED: '${env:USER}' };
	const queries: string[][] = [];
	using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, configuration], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async (names: readonly string[]) => { queries.push([...names]); return Object.fromEntries(names.map(name => [name, hostValues[name] ?? ''])); } }]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	const calls: string[] = [];
	using first = CommandsRegistry.register('resolver.nested.first', () => { calls.push('first'); return '${command:resolver.nested.second}/${env:USER}'; });
	using second = CommandsRegistry.register('resolver.nested.second', () => { calls.push('second'); return 'result'; });
	const source = Object.freeze({ env: Object.freeze({ 'ASH_${env:USER}': '${config:nested.a}' }), command: '${command:resolver.nested.first}', cycle: '${config:nested.cycle}' });
	assert.deepEqual(await services.get(IConfigurationResolverService).resolveWithInteractionReplace(workspace.getWorkspace().folders[0], source), { env: { ASH_target: 'A=target' }, command: 'result/target', cycle: '${config:nested.cycle}' });
	assert.deepEqual({ calls, queries }, { calls: ['first', 'second'], queries: [['USER'], ['FINAL'], ['REDIRECTED']] });
	assert.equal(source.command, '${command:resolver.nested.first}');
});

test('configured input replacement values discover later inputs and retain their definitions without invoking producers twice', async () => {
	using owner = new DisposableStore();
	using workspace = new WorkspaceContextService({ id: 'nested-inputs', uri: URI.file('/nested-inputs') });
	const folder = workspace.getWorkspace().folders[0]!;
	const definitions = ['host', 'site', 'tld'].map(id => ({ id, type: 'command', command: `resolver.nested.${id}` }));
	const { services } = inputServices(owner, workspace, [[URI.joinPath(folder.uri, '.vscode/tasks.json'), JSON.stringify({ inputs: definitions })]]);
	const calls: string[] = [];
	for (const [id, result] of Object.entries({ host: 'local.${input:site}.${input:tld}', site: 'example', tld: 'com' })) owner.add(CommandsRegistry.register(`resolver.nested.${id}`, () => { calls.push(id); return result; }));
	const expression = ConfigurationResolverExpression.parse({ 'ASH_${input:host}': '${input:host}' });
	assert.deepEqual(await services.get(IConfigurationResolverService).resolveWithInteractionReplace(folder, expression, 'tasks'), { 'ASH_local.example.com': 'local.example.com' });
	assert.deepEqual(calls, ['host', 'site', 'tld']);
	assert.deepEqual([...expression.resolved()].map(([reference, data]) => ({ id: reference.arg, definition: data.input })), definitions.map(definition => ({ id: definition.id, definition })));
});

test('configuration expressions reject excessive recursive expansion with a localized error before producing an unbounded value', () => {
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	const expression = ConfigurationResolverExpression.parse('${config:0}');
	for (const reference of expression.unresolved()) {
		const index = Number(reference.arg);
		expression.resolve(reference, index < 24 ? '${config:' + (index + 1) + '}${config:' + (index + 1) + '}' : 'end');
	}
	assert.throws(() => expression.toObject(), { message: '配置变量展开超出了支持的限制。' });
});

suite('ConfigurationResolverService execution platform selection', () => {
	for (const [os, key] of [[OperatingSystem.Windows, 'windows'], [OperatingSystem.Macintosh, 'osx'], [OperatingSystem.Linux, 'linux']] as const) {
		test(`selects ${key} before interactive resolution and preserves the source and cached expression`, async () => {
			using workspace = new WorkspaceContextService({ id: 'platform', uri: URI.file(os === OperatingSystem.Windows ? 'C:\\project' : '/project') });
			const base = createDisconnectedRendererApi();
			const host = { ...base, hasAppServer: true, appServer: { ...base.appServer, operatingSystem: os } };
			using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, host], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async () => ({}) }]));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			const seen: unknown[] = [];
			using commands = CommandsRegistry.registerMany([
				{ id: 'resolver.platform.selected', handler: (_accessor, config) => { seen.push(config); return '${workspaceFolderBasename}'; } },
				{ id: 'resolver.platform.unselected', handler: () => { assert.fail('An unselected platform executed a command'); } },
			]);
			const source = Object.freeze({ retained: true, program: 'default', env: { BASE: 'default' }, windows: { program: 'windows', env: { MODE: '${command:resolver.platform.unselected}' } }, osx: { program: 'osx', env: { MODE: '${command:resolver.platform.unselected}' } }, linux: { program: 'linux', env: { MODE: '${command:resolver.platform.unselected}' } }, [key]: { program: '${workspaceFolderBasename}', env: { MODE: '${command:resolver.platform.selected}' } } });
			const resolver = services.get(IConfigurationResolverService);
			const folder = workspace.getWorkspace().folders[0]!;
			assert.deepEqual(await resolver.resolveAsync(folder, source), { retained: true, program: 'project', env: { MODE: '${command:resolver.platform.selected}' } });
			assert.deepEqual(await resolver.resolveWithInteractionReplace(folder, source), { retained: true, program: 'project', env: { MODE: 'project' } });
			assert.deepEqual(seen, [{ retained: true, program: 'project', env: { MODE: '${command:resolver.platform.selected}' } }]);
			assert.equal(source.program, 'default');
			assert.equal(source[key].program, '${workspaceFolderBasename}');
			assert.deepEqual(await resolver.resolveAsync(undefined, { platform: 'default', [key]: { platform: key } }), { platform: key });
			const expression = ConfigurationResolverExpression.parse({ env: { windows: '${workspaceFolderBasename}' } });
			assert.deepEqual(await resolver.resolveAsync(folder, expression), { env: { windows: 'project' } });
		});
	}

	test('rejects unknown execution OS and malformed selected overrides in the current language without executing commands', async () => {
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		using workspace = new WorkspaceContextService({ id: 'platform', uri: URI.file('/project') });
		const base = createDisconnectedRendererApi();
		const host = { ...base, hasAppServer: true, appServer: { ...base.appServer, operatingSystem: undefined as OperatingSystem | undefined } };
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, host], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IWorkspaceContextService, workspace], [ITerminalProcessService, { getEnvironment: async () => ({}) }]));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		const resolver = services.get(IConfigurationResolverService);
		await assert.rejects(resolver.resolveWithInteractionReplace(undefined, { program: '${command:mustNotRun}', linux: {} }), { message: '执行主机的路径平台不可用。' });
		host.appServer.operatingSystem = OperatingSystem.Linux;
		await assert.rejects(resolver.resolveAsync(undefined, { linux: [] }), { message: '“linux”配置必须是对象。' });
		assert.deepEqual(await resolver.resolveAsync(undefined, { retained: true, osx: {} }), { retained: true });
	});
});
