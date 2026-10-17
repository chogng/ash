import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ILink, ILinkProvider } from '@xterm/xterm';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { posix, win32 } from '../../../../../../base/common/path.js';
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
import { WorkspaceContextService } from '../../../../../services/workspaces/browser/workspaceContextService.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../../../services/terminal/browser/terminal.js';
import { ITerminalConfigurationService } from '../../../../terminal/browser/terminal.js';
import { TerminalLinkContribution } from '../../browser/terminalLinkContribution.js';

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');
ensureNoDisposablesAreLeakedInTestSuite();

function fixture(lifetime: DisposableStore, root = URI.file('/project'), cwd = '/project', historicalCwd?: string) {
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
	const workspace = lifetime.add(new WorkspaceContextService({ id: 'project', uri: root }));
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IPathService, {
		getPath: async () => cwd.startsWith('C:') ? win32 : posix,
		fileURI: async (path: string) => URI.from({ scheme: 'file', path: path.replaceAll('\\', '/') }),
		resolvedUserHome: URI.file('/home/fixture'),
	} as unknown as IPathService);
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
		raw, contribution, opened, didOpen, paths, urls, states, warnings, originalLinkHandler,
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
