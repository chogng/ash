import { registerTestTerminalLifecycleServices } from '../../../../test/browser/workbenchTestServices.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITerminalProcessService, type ITerminalProcessCreation } from '../../../../../platform/terminal/common/terminal.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { TerminalService } from '../../browser/terminalService.js';
import { ITerminalService, type ITerminalView } from '../../../../services/terminal/browser/terminal.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TerminalTabsChatEntry } from '../../browser/terminalTabsChatEntry.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { captureTerminalAttachment } from '../../browser/chatTerminalCommandMirror.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { registerRemoteContributions } from '../../electron-browser/terminalRemote.js';
import '../../electron-browser/localTerminalBackend.js';

registerRemoteContributions();

function fixture(owner: DisposableStore, remote: boolean) {
	const workspace = owner.add(new WorkspaceContextService({ id: 'workspace', uri: remote ? URI.from({ scheme: 'ash-remote', authority: 'host-one', path: '/project' }) : URI.file('/project') }));
	const creation = new DeferredPromise<ITerminalProcessCreation>();
	const closed: string[] = [];
	const written: string[] = [];
	const queries: { terminalId: string; dirId?: string; }[] = [];
	let queryResult = Promise.resolve({ ready: { pid: 7, cwd: '/project' }, cwd: '/project/current', rows: 24, cols: 80 });
	const processes = {
		onConnectionState: () => Disposable.None, getConnectionState: async () => 'ready',
		create: () => creation.p,
		close: async ({ terminalId }: { terminalId: string; }) => { closed.push(terminalId); },
		write: async ({ data }: { data: string; }) => { written.push(data); },
		resize: async () => { },
		getProcessInfo: async (options: { terminalId: string; dirId?: string; }) => {
			queries.push(options);
			return queryResult;
		},
	} as unknown as ITerminalProcessService;
	const services = owner.add(new InstantiationService(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
	registerTestTerminalLifecycleServices(services);
	const terminals = owner.add(services.createInstance(TerminalService));
	services.registerInstance(ITerminalService, terminals);
	return {
		workspace, closed, written, queries, services, terminals,
		setQuery: (value: typeof queryResult) => { queryResult = value; },
		ready: () => creation.complete({ terminalId: 'original-pty', ready: { pid: 7, cwd: '/project' }, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'reconnectable' }),
		create: () => terminals.createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' }, deferStart: true }),
	};
}

suite('Terminal execution host boundaries', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const remote of [false, true]) test(`late ${remote ? 'remote' : 'local'} creation is released after workspace replacement`, async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, remote);
		await f.terminals.whenConnected;
		const pending = f.create();
		const rejected = assert.rejects(pending, isCancellationError);
		f.workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/other') });
		await f.ready();
		await rejected;
		assert.equal(f.terminals.instances.length, 0);
		assert.deepEqual(f.closed, ['original-pty']);
	});

	for (const remote of [false, true]) test(`${remote ? 'remote' : 'local'} stdin cannot migrate to a replacement execution host`, async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, remote);
		await f.terminals.whenConnected;
		const pending = f.create();
		await f.ready();
		const instance = await pending;
		await instance.sendText('original', false);
		f.workspace.updateWorkspace({ id: 'replacement', uri: URI.from({ scheme: 'ash-remote', authority: 'host-two', path: '/other' }) });
		await assert.rejects(instance.sendText('wrong-host', false), isCancellationError);
		assert.equal(f.written.length, 1);
		await f.terminals.closeTerminal(instance);
		assert.deepEqual(f.closed, ['original-pty']);
	});

	test('a remote PTY keeps its original cwd and input lease across folder changes on the same host', async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, true);
		await f.terminals.whenConnected;
		const pending = f.create();
		await f.ready();
		const instance = await pending;
		f.workspace.updateWorkspace({ id: 'other', uri: URI.from({ scheme: 'ash-remote', authority: 'host-one', path: '/other' }) });
		await instance.sendText('still-original', false);
		assert.equal(instance.initialCwd, '/project');
		assert.equal(f.written.length, 1);
		await instance.close();
	});

	for (const remote of [false, true]) test(`${remote ? 'remote' : 'local'} cwd queries reject a replaced execution host`, async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, remote);
		await f.terminals.whenConnected;
		const pending = f.create();
		await f.ready();
		const instance = await pending;
		const query = instance.capabilities!.get(TerminalCapability.NaiveCwdDetection)!;
		f.workspace.updateWorkspace({ id: 'replacement', uri: URI.from({ scheme: 'ash-remote', authority: 'host-two', path: '/other' }) });
		await assert.rejects(query.getCwd(), isCancellationError);
		assert.deepEqual(f.queries, []);
		await instance.close();
	});

	for (const remote of [false, true]) test(`late ${remote ? 'remote' : 'local'} cwd cannot escape a host replacement`, async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, remote);
		await f.terminals.whenConnected;
		const pending = f.create();
		await f.ready();
		const instance = await pending;
		const response = new DeferredPromise<{ ready: { pid: number; cwd: string; }; cwd: string; rows: number; cols: number; }>();
		f.setQuery(response.p);
		const rejected = assert.rejects(instance.capabilities!.get(TerminalCapability.NaiveCwdDetection)!.getCwd(), isCancellationError);
		assert.equal(f.queries.length, 1);
		f.workspace.updateWorkspace({ id: 'replacement', uri: URI.from({ scheme: 'ash-remote', authority: 'host-two', path: '/other' }) });
		await response.complete({ ready: { pid: 7, cwd: '/project' }, cwd: '/retired-host', rows: 24, cols: 80 });
		await rejected;
		await instance.close();
	});

	test('Attach to Chat captures before opening the draft and never submits', async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, false);
		await f.terminals.whenConnected;
		const pending = f.create();
		await f.ready();
		const instance = await pending;
		let text = 'accepted output';
		let attachment: ChatContextAttachment | undefined;
		f.services.registerInstance(IViewsService, {
			getViewWithId: () => ({ getTerminalOutput: async () => text }),
			openView: async () => {
				text = 'later output';
				return { addContext: (value: ChatContextAttachment) => { attachment = value; }, acceptInput: () => assert.fail('An attachment must not submit the draft') };
			},
		} as unknown as IViewsService);
		using entry = f.services.createInstance(TerminalTabsChatEntry);
		await entry.attach(instance);
		await instance.close();
		assert.equal(attachment?.terminalSnapshot?.text, 'accepted output');
		assert.match((await attachment!.resolve()).content, /accepted output/);
		assert.doesNotMatch((await attachment!.resolve()).content, /later output/);
	});

	test('capture canceled during the parsed screen read produces no attachment', async () => {
		using owner = new DisposableStore();
		const f = fixture(owner, false);
		await f.terminals.whenConnected;
		const pending = f.create();
		await f.ready();
		const instance = await pending;
		const controller = new AbortController();
		const view = { getTerminalOutput: async () => { controller.abort(); return 'not accepted'; } } as unknown as ITerminalView;
		assert.equal(await captureTerminalAttachment(instance, view, controller.signal), undefined);
		await instance.close();
	});
});
