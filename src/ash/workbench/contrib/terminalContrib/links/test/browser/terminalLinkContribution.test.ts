import { ITerminalProcessService } from '../../../../../../platform/terminal/common/terminal.js';
import { TerminalLinkResolver } from '../../browser/terminalLinkResolver.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ILink, ILinkProvider } from '@xterm/xterm';
import { DeferredPromise } from '../../../../../../base/common/async.js';
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
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../../terminal/browser/terminal.js';
import { ITerminalConfigurationService } from '../../../../terminal/browser/terminal.js';
import { TerminalLinkContribution } from '../../browser/terminalLinkContribution.js';

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');
ensureNoDisposablesAreLeakedInTestSuite();

function fixture(lifetime: DisposableStore, root = URI.file('/project'), cwd = '/project', historicalCwd?: string, environment: Readonly<Record<string, string>> = { HOME: '/home/fixture' }) {
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
	const urls: string[] = [];
	services.registerInstance(IOpenerService, { open: async url => { urls.push(String(url)); return true; } } as IOpenerService);
	const warnings: string[] = [];
	services.registerInstance(INotificationService, { warning: (message: string) => { warnings.push(message); } } as unknown as INotificationService);
	let pick: IQuickPick<IQuickPickItem> | undefined;
	const accepted = lifetime.add(new Emitter<void>());
	const hidden = lifetime.add(new Emitter<void>());
	services.registerInstance(IQuickInputService, {
		createQuickPick: () => {
			pick = {
				...Disposable.None, items: [], selectedItems: [], onDidAccept: accepted.event, onDidHide: hidden.event, onDidBlur: Event.None,
				show() { },
			} as unknown as IQuickPick<IQuickPickItem>;
			return pick;
		}
	} as unknown as IQuickInputService);
	services.registerInstance(ITerminalConfigurationService, { config: { showLinkHover: true }, onConfigChanged: Event.None } as ITerminalConfigurationService);
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
		raw, contribution, opened, didOpen, paths, urls, states, warnings, originalLinkHandler, environmentQueries,
		get providerDisposed() { return providerDisposed; }, get focuses() { return focuses; },
		setStat(value: typeof stat) { stat = value; },
		write(text: string) { return new Promise<void>(resolve => raw.write(text, resolve)); },
		links(line = 1) { return new Promise<ILink[] | undefined>(resolve => provider!.provideLinks(line, resolve)); },
		accept(index: number) { pick!.selectedItems = [pick!.items[index] as IQuickPickItem]; accepted.fire(); },
		cancel() { hidden.fire(); },
		get items() { return pick!.items; },
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

test('Terminal wrapped wide-character output keeps the file link on its actual cells', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('中😀 "/project/my file.ts:9:2"');
	const links = await f.links(2);
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

test('Terminal file detection omits missing files and discards async results after disposal', async () => {
	using lifetime = new DisposableStore();
	const f = fixture(lifetime);
	await f.write('src/missing.ts:4');
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
	await f.write('src/gone.ts:4');
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
