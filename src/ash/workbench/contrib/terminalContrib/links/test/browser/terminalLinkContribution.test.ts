import { ITerminalProcessService } from '../../../../../../platform/terminal/common/terminal.js';
import { TerminalLinkResolver } from '../../browser/terminalLinkResolver.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ILink, ILinkProvider } from '@xterm/xterm';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { OperatingSystem } from '../../../../../../base/common/platform.js';
import { IRendererHostService } from '../../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../../browser/rendererApi.js';
import { BrowserPathService } from '../../../../../services/path/browser/pathService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IRange } from '../../../../../../editor/common/core/range.js';
import { FileKind, IFileService, type IFileStat } from '../../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IPathService } from '../../../../../../platform/path/common/pathService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { TerminalCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IExplorerService } from '../../../../files/browser/files.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../../terminal/browser/terminal.js';
import { ITerminalConfigurationService } from '../../../../terminal/browser/terminal.js';
import { TerminalLinkContribution } from '../../browser/terminalLinkContribution.js';
import { ITerminalLinkProviderService } from '../../browser/links.js';
import { TerminalLinkProviderService } from '../../browser/terminalLinkProviderService.js';
import { ISearchService, type IFileQuery, type ISearchComplete } from '../../../../../services/search/common/search.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import '../../../../terminal/common/terminalConfiguration.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IHostService } from '../../../../../services/host/browser/host.js';
import { TestHostService } from '../../../../../services/host/test/browser/testHostService.js';
import { IExtensionService } from '../../../../../services/extensions/common/extensionService.js';
import { ILogService, NullLoggerService } from '../../../../../../platform/log/common/log.js';

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');
ensureNoDisposablesAreLeakedInTestSuite();

function fixture(lifetime: DisposableStore, root = URI.file('/project'), cwd = '/project', historicalCwd?: string, environment: Readonly<Record<string, string>> = { HOME: '/home/fixture' }, activate?: IExtensionService['activateByEvent']) {
	const dom = new JSDOM('<main></main>');
	lifetime.add(toDisposable(() => dom.window.close()));
	const raw = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
	lifetime.add(toDisposable(() => raw.dispose()));
	let provider: ILinkProvider | undefined;
	let providerDisposed = false;
	const register = raw.registerLinkProvider.bind(raw);
	raw.registerLinkProvider = value => {
		provider = value;
		const subscription = register(value);
		return { dispose() { providerDisposed = true; subscription.dispose(); } };
	};
	const services = lifetime.add(new InstantiationService());
	const activations: { event: string; signal: AbortSignal | undefined; }[] = [];
	services.registerInstance(IExtensionService, { activateByEvent: async (event, signal) => { activations.push({ event, signal }); await activate?.(event, signal); } } as IExtensionService);
	const activationErrors: unknown[][] = [];
	const log = new NullLoggerService();
	log.error = (...args: unknown[]) => activationErrors.push(args);
	services.registerInstance(ILogService, log);
	const host = new TestHostService();
	services.registerInstance(IHostService, host);
	const providers = lifetime.add(new TerminalLinkProviderService());
	services.registerInstance(ITerminalLinkProviderService, providers);
	const searches: IFileQuery[] = [];
	let search: ISearchService['fileSearch'] = async () => ({ results: [], messages: [] });
	services.registerInstance(ISearchService, { fileSearch: async (query, token) => { searches.push(query); return search(query, token); } } as ISearchService);
	const workspace = lifetime.add(new TestWorkspaceService({ id: 'project', uri: root }));
	services.registerInstance(IWorkspaceContextService, workspace);
	const api = createDisconnectedRendererApi();
	services.registerInstance(IRendererHostService, {
		...api, hasAppServer: true,
		appServer: { ...api.appServer, operatingSystem: cwd.startsWith('C:') && root.scheme === 'file' ? OperatingSystem.Windows : OperatingSystem.Linux, userHome: '/home/fixture' },
	});
	services.registerSingleton(IPathService, () => services.createInstance(BrowserPathService));
	const environmentQueries: { names: readonly string[]; dirId: string | undefined; }[] = [];
	services.registerInstance(ITerminalProcessService, {
		getEnvironment: async (names: readonly string[], dirId: string | undefined) => {
			environmentQueries.push({ names, dirId });
			return environment;
		},
	} as unknown as ITerminalProcessService);
	const states = lifetime.add(new Emitter<ITerminalInstance['state']>());
	const paths: string[] = [];
	let stat: (resource: URI) => Promise<IFileStat> = async resource => ({ resource, kind: FileKind.File, sizeBytes: 40, readonly: false, modifiedAtMillis: undefined });
	services.registerInstance(IFileService, { stat: async resource => { paths.push(resource.toString()); return stat(resource); } } as IFileService);
	const opened: { resource: string; selection?: IRange; }[] = [];
	const didOpen = new DeferredPromise<void>();
	services.registerInstance(IEditorService, {
		openEditor: async (input, options) => {
			opened.push({ resource: input.resource.toString(), selection: options?.selection ? { ...options.selection } : undefined });
			await didOpen.complete();
		}
	} as IEditorService);
	const revealed: { resource: string; reveal: boolean | string | undefined; }[] = [];
	const openedViews: string[] = [];
	let explorerFocuses = 0;
	const didFocusExplorer = new DeferredPromise<void>();
	const view = { focus() { explorerFocuses++; void didFocusExplorer.complete(); } };
	let openView = async () => view;
	services.registerInstance(IViewsService, {
		openView: async (id: string) => { openedViews.push(id); return openView(); },
	} as unknown as IViewsService);
	services.registerInstance(IExplorerService, {
		select: async (resource: URI, reveal?: boolean | string) => {
			revealed.push({ resource: resource.toString(), reveal });
		},
	} as unknown as IExplorerService);
	const urls: string[] = [];
	services.registerInstance(IOpenerService, { open: async url => { urls.push(String(url)); return true; } } as IOpenerService);
	const warnings: string[] = [];
	services.registerInstance(INotificationService, { warn: (message: string) => { warnings.push(message); } } as unknown as INotificationService);
	let pick: IQuickPick<IQuickPickItem> | undefined;
	let pickCount = 0;
	const shown = lifetime.add(new Emitter<number>());
	const accepted = lifetime.add(new Emitter<void>());
	const hidden = lifetime.add(new Emitter<void>());
	services.registerInstance(IQuickInputService, {
		createQuickPick: () => {
			pick = {
				...Disposable.None, items: [], selectedItems: [], onDidAccept: accepted.event, onDidHide: hidden.event, onDidBlur: Event.None,
				show() { shown.fire(++pickCount); },
			} as unknown as IQuickPick<IQuickPickItem>;
			return pick;
		}
	} as unknown as IQuickInputService);
	const config = { showLinkHover: true, enableFileLinks: 'on', wordSeparators: ' ()[]{}\',"`─‘’“”|' };
	services.registerInstance(ITerminalConfigurationService, { config, onConfigChanged: Event.None } as ITerminalConfigurationService);
	let focuses = 0;
	const screen = { raw, isDisposed: false, element: dom.window.document.querySelector('main'), focus: () => focuses++ } as unknown as IXtermTerminal;
	const instance = {
		dirId: 'project', processId: 17, cwd, initialCwd: cwd, onDidChangeState: states.event,
		capabilities: { get: (id: TerminalCapability) => id === TerminalCapability.CommandDetection ? { getCwdForLine: () => historicalCwd } : undefined },
	} as unknown as ITerminalInstance;
	const contribution = lifetime.add(services.createInstance(TerminalLinkContribution, { instance }));
	const originalLinkHandler = { activate() { } };
	raw.options.linkHandler = originalLinkHandler;
	contribution.xtermReady(screen);
	return {
		raw, contribution, opened, didOpen, paths, urls, states, warnings, originalLinkHandler, environmentQueries, revealed, openedViews, view, didFocusExplorer, providers, config, searches, host, activations, activationErrors,
		get providerDisposed() { return providerDisposed; }, get focuses() { return focuses; },
		get explorerFocuses() { return explorerFocuses; },
		setOpenView(value: typeof openView) { openView = value; },
		setStat(value: typeof stat) { stat = value; },
		setSearch(value: typeof search) { search = value; },
		write(text: string) { return new Promise<void>(resolve => raw.write(text, resolve)); },
		links(line = 1) { return new Promise<ILink[] | undefined>(resolve => provider!.provideLinks(line, resolve)); },
		accept(index: number) { pick!.selectedItems = [pick!.items[index] as IQuickPickItem]; accepted.fire(); },
		cancel() { hidden.fire(); },
		get items() { return pick!.items; },
		get placeholder() { return pick!.placeholder; },
		async waitForIdle() { while (pick?.busy) await new Promise<void>(resolve => setImmediate(resolve)); },
		waitForPicker(count = 1): Promise<void> {
			return pickCount >= count ? Promise.resolve() : new Promise(resolve => {
				const listener = lifetime.add(shown.event(value => { if (value >= count) { listener.dispose(); resolve(); } }));
			});
		},
	};
}

test('Terminal file link click uses the command cwd and opens its line and column', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime, URI.file('/project'), '/project/later', '/project/original');
	await f.write('src/main.ts:42:3');
	const links = await f.links();
	assert.equal(links?.length, 1);
	links![0]!.activate({} as MouseEvent, links![0]!.text);
	await f.didOpen.p;
	assert.deepEqual(f.opened, [{ resource: 'file:///project/original/src/main.ts', selection: { startLineNumber: 42, startColumn: 3, endLineNumber: 42, endColumn: 3 } }]);
});

test('Terminal directory links reveal the command directory through the existing Explorer from pointer and keyboard', async () => {
	for (const root of [URI.file('/project'), URI.parse('ash-remote://ssh+build/project')]) {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime, root, '/project/later', '/project/original');
		f.setStat(async resource => ({ resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }));
		await f.write('src/');
		const links = await f.links();
		assert.equal(links?.length, 1);
		links![0]!.activate({} as MouseEvent, links![0]!.text);
		await f.didFocusExplorer.p;
		assert.deepEqual(f.revealed, [{ resource: root.with({ path: '/project/original/src' }).toString(), reveal: 'force' }]);
		assert.deepEqual(f.openedViews, ['ash.explorer']);
		assert.equal(f.explorerFocuses, 1);
		assert.deepEqual(f.opened, []);
		const canceled = f.contribution.showLinkQuickpick();
		f.cancel();
		await canceled;
		assert.equal(f.focuses, 1);
		assert.equal(f.revealed.length, 1);
		const selected = f.contribution.showLinkQuickpick();
		f.accept(0);
		await selected;
		assert.deepEqual(f.revealed, [
			{ resource: root.with({ path: '/project/original/src' }).toString(), reveal: 'force' },
			{ resource: root.with({ path: '/project/original/src' }).toString(), reveal: 'force' },
		]);
		assert.equal(f.explorerFocuses, 2);
		assert.deepEqual(f.opened, []);
	}
});

test('Terminal local directory links open outside folders through the window host and retain stat authorization', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('../outside/');
	f.setStat(async resource => ({ resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }));
	const links = await f.links();
	assert.equal(links?.length, 1);
	links![0]!.activate({} as MouseEvent, links![0]!.text);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(f.host.opened.map(open => ({ resource: 'folderUri' in open.targets[0]! ? open.targets[0].folderUri.toString() : '', options: open.options })), [{ resource: 'file:///outside', options: { forceNewWindow: true } }]);
	const selected = f.contribution.showLinkQuickpick();
	f.accept(0);
	await selected;
	assert.equal(f.warnings.length, 0);
	assert.equal(f.host.opened.length, 2);
	assert.deepEqual(f.openedViews, []);
	assert.deepEqual(f.revealed, []);
	f.setStat(async () => { throw new Error('Access denied'); });
	assert.deepEqual(await f.links(), []);
	assert.deepEqual(f.opened, []);
});

for (const retire of ['dispose', 'reconnect'] as const) {
	test(`Terminal directory pointer activation drops a delayed stat after ${retire}`, async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		const resource = URI.file('/project/src');
		const directory = { resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
		f.setStat(async () => directory);
		await f.write('src/');
		const links = await f.links();
		const started = new DeferredPromise<void>();
		const stat = new DeferredPromise<IFileStat>();
		f.setStat(() => { void started.complete(); return stat.p; });
		links![0]!.activate({} as MouseEvent, links![0]!.text);
		await started.p;
		if (retire === 'dispose') f.contribution.dispose();
		else f.states.fire('reconnecting');
		await stat.complete(directory);
		// Advance one event-loop turn after resolving the stat so the pointer
		// activation's promise chain retires before checking the absent effects.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(f.openedViews, []);
		assert.deepEqual(f.revealed, []);
		assert.equal(f.explorerFocuses, 0);
	});

	test(`Terminal directory keyboard activation drops a delayed Explorer view after ${retire}`, async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		f.setStat(async resource => ({ resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }));
		await f.write('src/');
		const started = new DeferredPromise<void>();
		const view = new DeferredPromise<typeof f.view>();
		f.setOpenView(() => { void started.complete(); return view.p; });
		const selected = f.contribution.showLinkQuickpick();
		f.accept(0);
		await started.p;
		if (retire === 'dispose') f.contribution.dispose();
		else f.states.fire('reconnecting');
		await view.complete(f.view);
		await selected;
		assert.deepEqual(f.openedViews, ['ash.explorer']);
		assert.deepEqual(f.revealed, []);
		assert.equal(f.explorerFocuses, 0);
	});
}

test('Terminal directory picker and unavailable path warning use the active Chinese translations', async () => {
	using lifetime = new DisposableStore();
	lifetime.add(toDisposable(() => initializeTestLocalization('en')));
	initializeTestLocalization('zh-CN');
	const f = fixture(lifetime);
	await f.write('src/');
	f.setStat(async () => { throw new Error('Access denied'); });
	const selected = f.contribution.showLinkQuickpick();
	assert.equal(f.placeholder, '选择要打开的终端文件、文件夹或网址');
	f.accept(0);
	await selected;
	assert.deepEqual(f.warnings, ['无法打开终端中的路径：src/']);
});

test('Terminal wrapped wide-character output keeps the file link on its actual cells', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('中😀 "/project/my file.ts:9:2"');
	const links = (await f.links(2))?.filter(link => link.text.includes('my file.ts'));
	assert.equal(links?.length, 1);
	assert.equal(links![0]!.text, '/project/my file.ts:9:2');
	assert.deepEqual(links![0]!.range.start, { x: 6, y: 1 });
	assert.equal(f.raw.buffer.active.getLine(links![0]!.range.end.y - 1)!.getCell(links![0]!.range.end.x - 1)!.getChars(), '2');
	links![0]!.activate({} as MouseEvent, links![0]!.text);
	await f.didOpen.p;
	assert.equal(f.opened[0]!.resource, 'file:///project/my%20file.ts');
});

test('Terminal remote file links retain their execution authority and Windows links retain their drive', async () => {
	for (const { root, cwd, output, expected } of [
		{ root: URI.parse('ash-remote://ssh+build/project'), cwd: '/project/sub', output: '../src/main.rs:7:2', expected: 'ash-remote://ssh+build/project/src/main.rs' },
		{ root: URI.parse('file:///C:/project'), cwd: 'C:\\project', output: '"C:\\my files\\main.cs":5:3', expected: 'file:///C:/my%20files/main.cs' },
		{ root: URI.parse('ash-remote://ssh+windows/C%3A/project'), cwd: 'C:\\project', output: 'src\\main.rs:7:2', expected: 'ash-remote://ssh+windows/C%3A/project/src/main.rs' },
		{ root: URI.parse('ash-remote://ssh+windows/C%3A/project'), cwd: 'C:\\project', output: 'file://build/share/main.rs:7:2', expected: 'ash-remote://ssh+windows//build/share/main.rs' },
	]) {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime, root, cwd);
		await f.write(output);
		const links = await f.links();
		assert.equal(links?.length, 1, output);
		links![0]!.activate({} as MouseEvent, links![0]!.text);
		await f.didOpen.p;
		assert.equal(f.opened[0]!.resource, expected);
	}
});

test('Terminal link keyboard picker opens files and returns focus on cancellation', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('src/a.ts:4:2\r\nhttps://example.test/help');
	const canceled = f.contribution.showLinkQuickpick();
	f.cancel();
	await canceled;
	assert.equal(f.focuses, 1);
	const selected = f.contribution.showLinkQuickpick();
	assert.deepEqual(f.items.map(item => item.label), ['src/a.ts:4:2', 'https://example.test/help']);
	f.accept(0);
	await selected;
	assert.equal(f.opened[0]!.resource, 'file:///project/src/a.ts');
	const web = f.contribution.showLinkQuickpick();
	f.accept(1);
	await web;
	assert.deepEqual(f.urls, ['https://example.test/help']);
});

test('Terminal absolute file detection omits missing files and discards async results after disposal', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('/project/src/missing.ts:4');
	f.setStat(async () => { throw new Error('File not found'); });
	assert.deepEqual(await f.links(), []);
	const pendingStat = new DeferredPromise<IFileStat>();
	f.setStat(() => pendingStat.p);
	const pending = f.links();
	assert.notEqual(f.raw.options.linkHandler, f.originalLinkHandler);
	f.contribution.dispose();
	await pendingStat.complete({ resource: URI.file('/project/src/missing.ts'), kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined });
	assert.equal(await pending, undefined);
	assert.equal(f.providerDisposed, true);
	assert.equal(f.raw.options.linkHandler, f.originalLinkHandler);
	assert.deepEqual(f.opened, []);
});

test('Terminal link picker normalizes quoted locations without losing their buffer text', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('"/project/my file.ts":18:7');
	const links = await f.links();
	assert.equal(links?.[0]?.text, '/project/my file.ts":18:7');
	const selected = f.contribution.showLinkQuickpick();
	assert.deepEqual(f.items.map(item => item.label), ['/project/my file.ts:18:7']);
	f.accept(0);
	await selected;
	assert.deepEqual(f.opened, [{ resource: 'file:///project/my%20file.ts', selection: { startLineNumber: 18, startColumn: 7, endLineNumber: 18, endColumn: 7 } }]);
});

test('Terminal file links use the execution home and decode file URI paths', async () => {
	for (const { output, resource } of [
		{ output: '~/src/main.ts:4:2', resource: 'file:///home/fixture/src/main.ts' },
		{ output: 'file:///project/my%20file.ts:4:2', resource: 'file:///project/my%20file.ts' },
	]) {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		await f.write(output);
		const selected = f.contribution.showLinkQuickpick();
		f.accept(0);
		await selected;
		assert.deepEqual(f.opened, [{ resource, selection: { startLineNumber: 4, startColumn: 2, endLineNumber: 4, endColumn: 2 } }]);
	}
});

test('remote terminal home lookup uses the selected directory grant and never the ambient home', async () => {
	using lifetime = new DisposableStore();
	const root = URI.parse('ash-remote://ssh+windows/C%3A/project');
	const f = fixture(lifetime, root, 'C:\\project', undefined, { USERPROFILE: 'D:\\Users\\Remote' });
	await f.write('~\\src\\main.ts:4:2');
	const selected = f.contribution.showLinkQuickpick();
	f.accept(0);
	await selected;
	assert.equal(f.opened[0]?.resource, 'ash-remote://ssh+windows/D%3A/Users/Remote/src/main.ts');
	assert.deepEqual(f.environmentQueries, [{ names: ['USERPROFILE'], dirId: 'project' }]);
});

test('terminal resolver keeps drive, UNC and literal POSIX paths on their execution owner', async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const resources: string[] = [];
	services.registerInstance(IFileService, { stat: async (resource: URI) => { resources.push(resource.toString()); return { kind: FileKind.File }; } } as unknown as IFileService);
	const resolver = services.createInstance(TerminalLinkResolver);
	for (const { cwd, link, remoteAuthority, expected } of [
		{ cwd: 'C:\\work', link: '\\\\?\\D:\\src\\main.ts', remoteAuthority: 'ssh+build', expected: 'ash-remote://ssh+build/D%3A/src/main.ts' },
		{ cwd: 'C:\\work', link: '\\\\?\\UNC\\build\\share\\main.ts', remoteAuthority: undefined, expected: 'file://build/share/main.ts' },
		{ cwd: 'C:\\work', link: '\\src\\main.ts', remoteAuthority: 'ssh+build', expected: 'ash-remote://ssh+build/C%3A/src/main.ts' },
		{ cwd: '\\\\build\\share\\work', link: '..\\..\\main.ts', remoteAuthority: 'ssh+build', expected: 'ash-remote://ssh+build//build/share/main.ts' },
		{ cwd: 'C:\\work', link: 'file://build/share/main.ts', remoteAuthority: 'ssh+build', expected: 'ash-remote://ssh+build//build/share/main.ts' },
		{ cwd: '/work', link: 'part\\name.ts ', remoteAuthority: 'ssh+posix', expected: 'ash-remote://ssh+posix/work/part%5Cname.ts%20' },
	]) {
		const result = await resolver.resolveLink({ initialCwd: cwd, os: cwd.startsWith('/') ? OperatingSystem.Linux : OperatingSystem.Windows, remoteAuthority }, link, link.startsWith('file:') ? URI.parse(link) : undefined);
		assert.equal(result?.uri.toString(), expected, link);
	}
	const count = resources.length;
	for (const link of ['D:relative.ts', '\\\\?\\GLOBALROOT\\Device', '~/missing-home.ts']) {
		assert.equal(await resolver.resolveLink({ initialCwd: 'C:\\work', os: OperatingSystem.Windows }, link), null);
	}
	assert.equal(await resolver.resolveLink({ initialCwd: 'C:\\work', os: OperatingSystem.Windows }, 'file:///C:/work/file.ts#fragment', URI.parse('file:///C:/work/file.ts#fragment')), null);
	assert.equal(resources.length, count, 'Invalid or unavailable paths must not reach the file provider');
});

test('Terminal links preserve a real space at a wrap boundary and omit wide-glyph padding', async () => {
	for (const file of ['/project/a file.ts', '/project/a中.ts']) {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		f.raw.resize(12, 5);
		await f.write(`"${file}":4:2`);
		const selected = f.contribution.showLinkQuickpick();
		assert.deepEqual(f.items.map(item => item.label), [`${file}:4:2`]);
		f.accept(0);
		await selected;
		assert.equal(f.opened[0]!.resource, URI.file(file).toString());
	}
});

test('Terminal link selection reports unavailable files and drops results during reconnection', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('/project/src/gone.ts:4');
	f.setStat(async () => { throw new Error('File not found'); });
	const selected = f.contribution.showLinkQuickpick();
	f.accept(0);
	await selected;
	assert.equal(f.warnings.length, 1);
	assert.match(f.warnings[0]!, /src\/gone.ts/u);
	const stat = new DeferredPromise<IFileStat>();
	f.setStat(() => stat.p);
	const pending = f.links();
	f.states.fire('reconnecting');
	await stat.complete({ resource: URI.file('/project/src/gone.ts'), kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined });
	assert.equal(await pending, undefined);
	assert.deepEqual(f.opened, []);
});

test('Terminal link history scan yields and cannot open a picker after its instance closes', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write(`${'synthetic output\r\n'.repeat(300)}src/main.ts:4:2`);
	const scanning = f.contribution.showLinkQuickpick();
	f.contribution.dispose();
	await scanning;
	assert.equal(f.focuses, 0);
	assert.deepEqual(f.opened, []);
});

test('Terminal relative link searches its execution workspace and preserves source location', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	f.setStat(async () => { throw new Error('Not in command cwd'); });
	f.setSearch(async () => ({
		results: [
			{ resource: URI.file('/other/main.ts') },
			{ resource: URI.file('/project/src/main.ts') },
		], messages: []
	}));
	await f.write('main.ts:12:3');
	const links = await f.links();
	assert.equal(f.searches.length, 0, 'Hover detection must not search the workspace');
	links![0]!.activate({} as MouseEvent, links![0]!.text);
	await f.didOpen.p;
	assert.deepEqual(f.searches.map(query => ({ folders: query.folderQueries.map(folder => folder.folder.toString()), pattern: query.filePattern })), [{ folders: ['file:///project'], pattern: 'main.ts' }]);
	assert.deepEqual(f.opened, [{ resource: 'file:///project/src/main.ts', selection: { startLineNumber: 12, startColumn: 3, endLineNumber: 12, endColumn: 3 } }]);
});

test('Terminal ambiguous workspace links require selection and cancel returns terminal focus', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	f.setStat(async () => { throw new Error('Not in command cwd'); });
	f.setSearch(async () => ({ results: [{ resource: URI.file('/project/a/README') }, { resource: URI.file('/project/b/README') }], messages: [] }));
	await f.write('README');
	const links = await f.links();
	links![0]!.activate({} as MouseEvent, links![0]!.text);
	await f.waitForPicker();
	assert.deepEqual(f.items.map(item => item.label), ['/project/a/README', '/project/b/README']);
	f.cancel();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(f.focuses, 1);
	assert.equal(f.opened.length, 0);
	links![0]!.activate({} as MouseEvent, links![0]!.text);
	await f.waitForPicker(2);
	f.accept(1);
	await f.didOpen.p;
	assert.equal(f.opened[0]?.resource, 'file:///project/b/README');
});

test('Terminal workspace search ignores late results after reconnect', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	f.setStat(async () => { throw new Error('Not in command cwd'); });
	const started = new DeferredPromise<void>();
	const result = new DeferredPromise<ISearchComplete>();
	let token: CancellationToken | undefined;
	f.setSearch((_query, value) => { token = value; void started.complete(); return result.p; });
	await f.write('main.ts');
	const links = await f.links();
	links![0]!.activate({} as MouseEvent, links![0]!.text);
	await started.p;
	f.states.fire('reconnecting');
	assert.equal(token?.isCancellationRequested, true);
	await result.complete({ results: [{ resource: URI.file('/project/src/main.ts') }], messages: [] });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(f.opened, []);
	assert.deepEqual(f.warnings, []);
});

test('Terminal external providers own wrapped pointer and keyboard links and retire on unregister', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	const activated: string[] = [];
	const lines: string[] = [];
	const registration = lifetime.add(f.providers.registerLinkProvider({
		provideLinks: async (_instance, line) => {
			lines.push(line);
			const index = line.indexOf('JOB-123');
			return index < 0 ? [] : [
				{ startIndex: index, length: 7, label: 'Build job', activate: text => activated.push(text) },
				{ startIndex: -1, length: 100, activate() { throw new Error('Invalid provider link activated'); } },
			];
		}
	}));
	f.raw.resize(12, 5);
	await f.write('中😀 padding JOB-123');
	const links = await f.links(2);
	const external = links!.find(link => link.text === 'JOB-123')!;
	assert.ok(external);
	assert.equal(lines[0], '中😀 padding JOB-123');
	external.activate({} as MouseEvent, external.text);
	assert.deepEqual(activated, ['JOB-123']);
	const picker = f.contribution.showLinkQuickpick();
	await f.waitForPicker();
	await f.waitForIdle();
	f.accept(f.items.findIndex(item => item.label === 'Build job'));
	await picker;
	assert.deepEqual(activated, ['JOB-123', 'JOB-123']);
	registration.dispose();
	external.activate({} as MouseEvent, external.text);
	assert.deepEqual(activated, ['JOB-123', 'JOB-123']);
	assert.equal(f.providers.linkProviders.size, 0);
});

test('Terminal file-link policy and word separators affect detection without disabling URL links', async () => {
	for (const root of [URI.file('/project'), URI.parse('ash-remote://ssh+build/project')]) {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime, root);
		await f.write('README|LICENSE\r\nhttps://example.test');
		assert.deepEqual((await f.links())?.map(link => link.text), ['README', 'LICENSE']);
		f.config.enableFileLinks = 'notRemote';
		assert.equal((await f.links())?.length, root.scheme === 'file' ? 2 : 0);
		f.config.enableFileLinks = 'off';
		assert.deepEqual(await f.links(), []);
		assert.deepEqual((await f.links(2))?.map(link => link.text), ['https://example.test']);
	}
});

test('Terminal link configuration exposes defaults and translated descriptions', () => {
	using lifetime = new DisposableStore();
	lifetime.add(toDisposable(() => initializeTestLocalization('en')));
	initializeTestLocalization('zh-CN');
	const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	const files = registry.getConfiguration('terminal.integrated.enableFileLinks');
	const words = registry.getConfiguration('terminal.integrated.wordSeparators');
	assert.equal(files?.defaultValue, 'on');
	assert.equal(files?.schema?.description, '始终启用、停用终端文件链接，或仅在本地工作区中启用。');
	assert.equal(words?.schema?.description, '终端选词和工作区文件链接使用的单词分隔字符。');
	assert.throws(() => files?.parse('sometimes'));
});

test('Terminal remote outside folders cannot be interpreted as native host paths', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime, URI.parse('ash-remote://ssh+build/project'));
	f.setStat(async resource => ({ resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }));
	await f.write('../outside/');
	assert.deepEqual(await f.links(), []);
	const picker = f.contribution.showLinkQuickpick();
	f.accept(0);
	await picker;
	assert.equal(f.warnings.length, 1);
	assert.equal(f.host.opened.length, 0);
	assert.deepEqual(f.revealed, []);
});

test('Terminal outside folder links report a host that cannot open a new window', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	f.host.openWindow = async () => { throw new Error('New window is unavailable'); };
	f.setStat(async resource => ({ resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }));
	await f.write('../outside/');
	const picker = f.contribution.showLinkQuickpick();
	f.accept(0);
	await picker;
	assert.equal(f.warnings.length, 1);
	assert.equal(f.host.opened.length, 0);
});

test('Terminal outside folder activation cannot open a window after its instance retires', async () => {
	for (const retire of ['dispose', 'reconnect'] as const) {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		const directory = { resource: URI.file('/outside'), kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
		f.setStat(async () => directory);
		await f.write('../outside/');
		const links = await f.links();
		const started = new DeferredPromise<void>();
		const pending = new DeferredPromise<IFileStat>();
		f.setStat(() => { void started.complete(); return pending.p; });
		links![0]!.activate({} as MouseEvent, links![0]!.text);
		await started.p;
		if (retire === 'dispose') f.contribution.dispose();
		else f.states.fire('reconnecting');
		await pending.complete(directory);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.host.opened.length, 0);
	}
});

test('Terminal external history links load incrementally with four requests and stop scheduling on cancellation', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	const pending: { line: string; result: DeferredPromise<import('../../../../terminal/browser/terminal.js').ITerminalLink[]>; }[] = [];
	lifetime.add(f.providers.registerLinkProvider({
		provideLinks: async (_instance, line) => {
			const result = new DeferredPromise<import('../../../../terminal/browser/terminal.js').ITerminalLink[]>();
			pending.push({ line, result });
			return result.p;
		}
	}));
	await f.write(Array.from({ length: 20 }, (_, index) => `JOB-${index}`).join('\r\n'));
	const picker = f.contribution.showLinkQuickpick();
	await f.waitForPicker();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(pending.length, 4);
	assert.ok(f.items.some(item => item.label === 'JOB-19'), 'Built-in links must be usable before providers respond');
	const finish = async (index: number) => {
		const request = pending[index]!;
		await request.result.complete([{ startIndex: 0, length: request.line.length, label: `external ${request.line}`, activate() { } }]);
		await new Promise<void>(resolve => setImmediate(resolve));
	};
	await finish(0);
	await finish(2);
	assert.deepEqual(f.items.filter(item => item.label?.startsWith('external ')).map(item => item.label), ['external JOB-17', 'external JOB-19']);
	const count = pending.length;
	f.cancel();
	await picker;
	for (const request of pending) {
		if (!request.result.isSettled) await request.result.complete([]);
	}
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(pending.length, count, 'Canceled history lookup must not schedule the remaining lines');
	assert.equal(f.focuses, 1);
});

test('Terminal external history lookup closes and stops its workers when the provider unregisters', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	const pending = new DeferredPromise<import('../../../../terminal/browser/terminal.js').ITerminalLink[]>();
	let calls = 0;
	const registration = lifetime.add(f.providers.registerLinkProvider({ provideLinks: async () => { calls++; return pending.p; } }));
	await f.write(Array.from({ length: 20 }, (_, index) => `JOB-${index}`).join('\r\n'));
	const picker = f.contribution.showLinkQuickpick();
	await f.waitForPicker();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(calls, 4);
	registration.dispose();
	await picker;
	await pending.complete([{ startIndex: 0, length: 1, label: 'Stale external', activate() { throw new Error('Stale link activated'); } }]);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(calls, 4);
	assert.equal(f.items.some(item => item.label === 'Stale external'), false);
});

test('Terminal reachability activates lazy link providers once while keeping built-in links usable', async () => {
	using lifetime = new DisposableStore();
	const pending = new DeferredPromise<void>();
	const activated: string[] = [];
	const f = fixture(lifetime, undefined, undefined, undefined, undefined, async () => {
		await pending.p;
		lifetime.add(f.providers.registerLinkProvider({ provideLinks: async (_instance, line) => line === 'JOB-123' ? [{ startIndex: 0, length: 7, label: 'Lazy job', activate: text => activated.push(text) }] : [] }));
	});
	await f.write('JOB-123');
	const picker = f.contribution.showLinkQuickpick();
	await f.waitForPicker();
	assert.deepEqual(f.activations.map(value => value.event), ['onTerminal']);
	assert.ok(f.items.some(item => item.label === 'JOB-123'));
	await f.links();
	await f.links();
	assert.equal(f.activations.length, 1, 'Line detection must not request extension activation');
	await pending.complete();
	await f.waitForIdle();
	f.accept(f.items.findIndex(item => item.label === 'Lazy job'));
	await picker;
	assert.deepEqual(activated, ['JOB-123']);
});

test('Terminal lazy link activation failures are logged and disposal cancels pending activation', async () => {
	using lifetime = new DisposableStore();
	const failed = fixture(lifetime, undefined, undefined, undefined, undefined, async () => { throw new Error('Provider startup failed'); });
	await failed.write('README');
	assert.equal(failed.activationErrors.length, 1);
	assert.deepEqual(failed.warnings, []);
	const pending = new DeferredPromise<void>();
	const canceled = fixture(lifetime, undefined, undefined, undefined, undefined, () => pending.p);
	await canceled.write('README');
	assert.equal(canceled.activations.length, 1);
	canceled.contribution.dispose();
	assert.equal(canceled.activations[0]?.signal?.aborted, true);
	await pending.error(new Error('Canceled provider startup'));
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(canceled.activationErrors, []);
});

test('Terminal lazy link activation treats host cancellation as completion and permits retry', async () => {
	using lifetime = new DisposableStore();
	let attempts = 0;
	const f = fixture(lifetime, undefined, undefined, undefined, undefined, async () => {
		if (++attempts === 1) throw new CancellationError();
	});
	await f.write('README');
	assert.equal(f.activations[0]?.signal?.aborted, false);
	assert.deepEqual(f.activationErrors, []);
	const picker = f.contribution.showLinkQuickpick();
	await f.waitForPicker();
	await f.waitForIdle();
	assert.equal(attempts, 2);
	f.cancel();
	await picker;
	assert.deepEqual(f.activationErrors, []);
});
