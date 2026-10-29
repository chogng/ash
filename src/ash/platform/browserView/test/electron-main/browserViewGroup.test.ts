import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserViewGroupMainService } from '../../electron-main/browserViewGroupMainService.js';
import { BrowserViewStorageScope } from '../../common/browserView.js';
import type { CDPEvent, CDPResponse } from '../../common/cdp/types.js';
import { fixture } from './browserView.test.js';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import type { BrowserCdpOperationDto } from '../../../../../../.build/protocol/typescript/index.js';

suite('Browser view groups', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Main rejects file commands, local URL reads and drag paths on both page and child sessions', async () => {
		using f = fixture();
		const page = await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const group = await groups.createGroup({ sandboxSessionId: 'one', agentOnly: true });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(group)(message => messages.push(message)));
		let id = 0;
		await groups.sendCDPMessage(group, {
			id: ++id,
			method: 'Target.attachToTarget',
			params: { targetId: page.id, flatten: true },
		});
		const parent = ((messages.at(-1) as CDPResponse).result as { sessionId: string }).sessionId;
		await groups.sendCDPMessage(group, {
			id: ++id,
			method: 'Target.setAutoAttach',
			params: { autoAttach: true, flatten: true },
			sessionId: parent,
		});
		page.webContents.debugger.emit(
			'message',
			{},
			'Target.attachedToTarget',
			{
				sessionId: 'chromium-child',
				targetInfo: {
					targetId: 'child',
					type: 'iframe',
					title: '',
					url: 'about:blank',
					attached: true,
					browserContextId: page.session.id,
				},
				waitingForDebugger: false,
			},
			f.debugSessions[0],
		);
		const child = ((messages.at(-1) as CDPEvent).params as { sessionId: string }).sessionId;
		assert.ok(child);
		const before = f.commands.length;
		for (const sessionId of [parent, child]) {
			for (const [method, params] of [
				['DOM.setFileInputFiles', { files: ['/unapproved/secret.txt'], backendNodeId: 1 }],
				['DOM.getFileInfo', { objectId: 'file' }],
				['FileSystem.getDirectory', { bucketFileSystemLocator: { storageKey: 'local' } }],
				['Network.loadNetworkResource', { url: 'file:///unapproved/secret.txt', options: {} }],
				['Page.navigate', { url: 'FILE:///unapproved/secret.txt' }],
				['Page.getResourceContent', { url: 'file:///unapproved/secret.txt', frameId: 'frame' }],
				['Fetch.continueRequest', { url: 'file:///unapproved/secret.txt', requestId: 'request' }],
				[
					'Input.dispatchDragEvent',
					{
						type: 'drop',
						x: 0,
						y: 0,
						data: { items: [], dragOperationsMask: 1, files: ['/unapproved/secret.txt'] },
					},
				],
				['Future.readLocalFile', { path: '/unapproved/secret.txt' }],
			] as const) {
				await groups.sendCDPMessage(group, { id: ++id, method, params, sessionId });
				assert.match((messages.at(-1) as CDPResponse).error!.message, /Browser(FileAccessDenied|CDPMethodDenied)/);
			}
		}
		assert.equal(f.commands.length, before);
		await groups.sendCDPMessage(group, {
			id: ++id,
			method: 'Runtime.evaluate',
			params: { expression: '1 + 1' },
			sessionId: child,
		});
		assert.equal(f.commands.at(-1)!.method, 'Runtime.evaluate');
		assert.equal((messages.at(-1) as CDPResponse).error, undefined);
	});

	test('advanced CDP scopes contexts and event buffers to a Thread and closes them on revocation', async () => {
		using f = fixture();
		using host = f.createHost();
		const page = await f.create();
		const perform = (operation: BrowserCdpOperationDto, targetId = page.id, threadId = 'thread-one') =>
			host.perform({ threadId, action: { type: 'cdp', targetId, operation } }, { signal: new AbortController().signal });
		await assert.rejects(perform({ type: 'command', method: 'Runtime.enable', params: {} }), /BrowserCDPDisabled/);
		await host.configure({ enabled: true, cdpEnabled: true });
		await perform({ type: 'command', method: 'Runtime.enable', params: {} });
		await perform({ type: 'readEvents' });
		for (let i = 0; i < 300; i++) {
			page.webContents.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { value: i }, f.debugSessions[0]);
		}
		const events = JSON.parse((await perform({ type: 'readEvents' })).output!);
		assert.equal(events.events.length, 256);
		assert.equal(events.dropped, 44);
		assert.equal(events.events[0].params.value, 44);
		const sibling = await perform({
			type: 'command',
			method: 'Target.createTarget',
			params: { url: 'about:blank', browserContextId: page.session.id },
		});
		assert.equal(f.manager.tryGetBrowserView(sibling.createdTargetId!)!.session, page.session);
		const context = JSON.parse((await perform({ type: 'command', method: 'Target.createBrowserContext', params: {} })).output!).result.browserContextId;
		const created = await perform({
			type: 'command',
			method: 'Target.createTarget',
			params: { url: 'about:blank', browserContextId: context },
		});
		assert.equal(f.manager.tryGetBrowserView(created.createdTargetId!)!.session.id, context);
		const other = await f.manager.createTarget('about:blank', 'thread-two', new AbortController().signal);
		const denied = await perform(
			{
				type: 'command',
				method: 'Target.createTarget',
				params: { url: 'about:blank', browserContextId: context },
			},
			other.id,
			'thread-two',
		);
		assert.match(JSON.parse(denied.output!).error.message, /BrowserContextAccessDenied/);
		const released = await perform({ type: 'close' });
		assert.deepEqual(released.closedTargetIds, [created.createdTargetId]);
		await host.configure({ enabled: true, cdpEnabled: false });
		assert.equal(f.manager.tryGetBrowserView(created.createdTargetId!), undefined);
		assert.ok(f.manager.tryGetBrowserView(page.id));
		await assert.rejects(perform({ type: 'readEvents' }), /BrowserCDPDisabled/);
		await host.configure({ enabled: false, cdpEnabled: false });
		assert.equal(f.manager.tryGetBrowserView(page.id), undefined);
		await assert.rejects(host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: new AbortController().signal }), /BrowserCapabilityUnavailable/);
	});

	test('disabling CDP cancels an evaluation and excludes shared user pages from its targets', async () => {
		using f = fixture();
		using host = f.createHost();
		const page = await f.create();
		await host.configure({ enabled: true, cdpEnabled: true });
		const userId = 'browser_target_123e4567-e89b-12d3-a456-426614174001';
		await f.manager.getOrCreateBrowserView(userId, {
			initialUrl: 'about:blank',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		await f.manager.setSharing(userId, ['thread-one']);
		const perform = (operation: BrowserCdpOperationDto) =>
			host.perform({ threadId: 'thread-one', action: { type: 'cdp', targetId: page.id, operation } }, { signal: new AbortController().signal });
		const targets = JSON.parse((await perform({ type: 'command', method: 'Target.getTargets', params: {} })).output!).result.targetInfos;
		assert.deepEqual(
			targets.map((target: { browserViewId: string }) => target.browserViewId),
			[page.id],
		);
		const started = promiseWithResolvers<void>();
		const finished = promiseWithResolvers<unknown>();
		f.command = async method => {
			if (method === 'Runtime.evaluate') {
				started.resolve();
				return finished.promise;
			}
			return {};
		};
		const pending = perform({
			type: 'command',
			method: 'Runtime.evaluate',
			params: { expression: 'new Promise(() => {})', awaitPromise: true },
		});
		const cancelled = assert.rejects(pending, /BrowserRequestCancelled/);
		await started.promise;
		await host.configure({ enabled: true, cdpEnabled: false });
		await cancelled;
		finished.resolve({ result: { value: 'withheld' } });
		assert.ok(f.manager.tryGetBrowserView(page.id));
		assert.ok(f.manager.tryGetBrowserView(userId));
	});
	test('automatic attachments belong to the browser session that requested them', async () => {
		using f = fixture();
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const id = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		const parents: string[] = [];
		for (const commandId of [1, 2]) {
			await groups.sendCDPMessage(id, { id: commandId, method: 'Target.attachToBrowserTarget' });
			parents.push(((messages.at(-1) as CDPResponse).result as { sessionId: string }).sessionId);
		}
		for (const sessionId of parents) {
			await groups.sendCDPMessage(id, {
				id: 3,
				method: 'Target.setAutoAttach',
				params: { autoAttach: true, flatten: true },
				sessionId,
			});
		}
		await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		await groups.sendCDPMessage(id, { id: 4, method: 'Target.getTargets' });
		assert.deepEqual(
			messages.filter(message => 'method' in message && message.method === 'Target.attachedToTarget').map(message => message.sessionId),
			parents,
		);
		await groups.sendCDPMessage(id, {
			id: 5,
			method: 'Target.setAutoAttach',
			params: { autoAttach: false, flatten: true },
			sessionId: parents[0],
		});
		assert.equal(messages.filter(message => 'method' in message && message.method === 'Target.detachedFromTarget').length, 1);
		messages.length = 0;
		await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		await groups.sendCDPMessage(id, { id: 6, method: 'Target.getTargets' });
		assert.deepEqual(
			messages.filter(message => 'method' in message && message.method === 'Target.attachedToTarget').map(message => message.sessionId),
			[parents[1]],
		);
	});

	test('CDP creation returns Chromium identity and cannot add targets to a fixed selection', async () => {
		using f = fixture();
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const id = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		await groups.sendCDPMessage(id, { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
		const page = (await f.manager.getBrowserViews())[0]!;
		assert.deepEqual((messages.at(-1) as CDPResponse).result, {
			targetId: await f.manager.tryGetBrowserView(page.id)!.debugger.getTargetId(),
			browserViewId: page.id,
		});
		const fixed = await groups.createGroup({ sandboxSessionId: 'one', browserIds: [page.id] });
		f.store.add(groups.onDynamicCDPMessage(fixed)(message => messages.push(message)));
		await groups.sendCDPMessage(fixed, { id: 2, method: 'Target.createTarget', params: { url: 'about:blank' } });
		assert.equal((messages.at(-1) as CDPResponse).error?.message, 'BrowserGroupHasFixedTargets');
		assert.equal((await f.manager.getBrowserViews()).length, 1);
	});

	test('closing a page during CDP discovery releases its lease and keeps the group usable', async () => {
		using f = fixture();
		const page = await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		const original = page.webContents.debugger.sendCommand.bind(page.webContents.debugger);
		page.webContents.debugger.sendCommand = async (method, params, sessionId) => {
			started.resolve();
			await finish.promise;
			return original(method, params, sessionId);
		};
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const creating = groups.createGroup({ sandboxSessionId: 'one' });
		await started.promise;
		await f.manager.destroyBrowserView(page.id);
		finish.resolve();
		const id = await creating;
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		await groups.sendCDPMessage(id, { id: 1, method: 'Target.getTargets' });
		assert.deepEqual((messages.at(-1) as CDPResponse).result, { targetInfos: [] });
		assert.equal(f.attached, false);
	});
	test('a Thread group discovers its pages dynamically and denies explicit access to other storage', async () => {
		using f = fixture();
		const first = await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		const other = await f.manager.createTarget('about:blank', 'two', new AbortController().signal);
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		await assert.rejects(groups.createGroup({ sandboxSessionId: 'one', browserIds: [other.id] }), /BrowserTargetAccessDenied/);
		const id = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		await groups.sendCDPMessage(id, { id: 1, method: 'Target.getTargets' });
		assert.deepEqual((messages.at(-1) as CDPResponse).result, {
			targetInfos: [
				{
					targetId: await first.debugger.getTargetId(),
					browserViewId: first.id,
					type: 'page',
					title: 'Example',
					url: 'about:blank',
					attached: false,
					canAccessOpener: false,
					browserContextId: first.session.id,
				},
			],
		});
		await groups.sendCDPMessage(id, {
			id: 2,
			method: 'Target.attachToTarget',
			params: { targetId: other.id, flatten: true },
		});
		assert.match((messages.at(-1) as CDPResponse).error!.message, /BrowserTargetAccessDenied/);
		await groups.sendCDPMessage(id, {
			id: 3,
			method: 'Target.setAutoAttach',
			params: { autoAttach: true, flatten: true },
		});
		const sibling = await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		await groups.sendCDPMessage(id, { id: 4, method: 'Target.getTargets' });
		assert.equal(messages.filter(message => 'method' in message && message.method === 'Target.attachedToTarget').length, 2);
		await groups.destroyGroup(id);
		assert.ok(f.manager.tryGetBrowserView(first.id));
		assert.ok(f.manager.tryGetBrowserView(sibling.id));
		assert.equal(f.attached, false);
	});

	test('groups borrow one debugger, scope commands and events, and release only their own leases', async () => {
		using f = fixture();
		const page = await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const first = await groups.createGroup({ sandboxSessionId: 'one' });
		const second = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(first)(message => messages.push(message)));
		await groups.sendCDPMessage(first, {
			id: 1,
			method: 'Target.attachToTarget',
			params: { targetId: page.id, flatten: true },
		});
		const sessionId = ((messages.at(-1) as CDPResponse).result as { sessionId: string }).sessionId;
		await groups.sendCDPMessage(second, {
			id: 2,
			method: 'Target.setAutoAttach',
			params: { autoAttach: true, flatten: true },
		});
		await groups.sendCDPMessage(first, {
			id: 3,
			method: 'Runtime.evaluate',
			params: { expression: '1 + 1' },
			sessionId,
		});
		assert.equal(f.commands.at(-1)?.method, 'Runtime.evaluate');
		assert.equal(f.commands.at(-1)?.sessionId, f.debugSessions[0]);
		assert.notEqual(f.debugSessions[0], f.debugSessions[1]);
		await groups.sendCDPMessage(first, { id: 4, method: 'Target.getTargets', sessionId });
		assert.deepEqual(
			((messages.at(-1) as CDPResponse).result as { targetInfos: { browserViewId: string }[] }).targetInfos.map(info => info.browserViewId),
			[page.id],
		);
		page.webContents.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { value: 'one' }, f.debugSessions[0]);
		assert.deepEqual(messages.at(-1), { method: 'Runtime.consoleAPICalled', params: { value: 'one' }, sessionId });
		await groups.sendCDPMessage(second, { id: 4, method: 'Runtime.evaluate', sessionId });
		await groups.destroyGroup(first);
		assert.equal(f.attached, true);
		await groups.destroyGroup(second);
		assert.equal(f.attached, false);
		assert.ok(f.manager.tryGetBrowserView(page.id));
	});

	test('a disconnected worker releases its caller while issued Chromium commands keep their page turn', async () => {
		using f = fixture();
		const page = await f.create();
		const lease = f.store.add(page.debugger.acquire());
		let finish!: () => void;
		f.command = async () => {
			await new Promise<void>(resolve => {
				finish = resolve;
			});
			return {};
		};
		const chromium = page.debugger.sendCommand('Runtime.evaluate');
		await assert.rejects(
			page.runOperation(new AbortController().signal, async () => {
				throw new Error('IPC connection closed');
			}),
			/IPC connection closed/,
		);
		let navigated = false;
		f.load = async url => {
			navigated = true;
			f.url = url;
		};
		const navigation = page.loadURL('https://example.test/next');
		await Promise.resolve();
		assert.equal(navigated, false);
		finish();
		await Promise.all([chromium, navigation]);
		assert.equal(navigated, true);
		lease.dispose();
	});

	test('revoking a shared page detaches its Thread and withholds an in-flight CDP result while retaining the page', async () => {
		using f = fixture();
		const pageId = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
		await f.manager.getOrCreateBrowserView(pageId, {
			initialUrl: 'about:blank',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const id = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		await f.manager.setSharing(pageId, ['one']);
		await groups.sendCDPMessage(id, {
			id: 1,
			method: 'Target.attachToTarget',
			params: { targetId: pageId, flatten: true },
		});
		const sessionId = ((messages.at(-1) as CDPResponse).result as { sessionId: string }).sessionId;
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.command = async () => {
			started.resolve();
			await finish.promise;
			return { secret: 'signed-in content' };
		};
		const command = groups.sendCDPMessage(id, {
			id: 2,
			method: 'Runtime.evaluate',
			params: { expression: 'document.body.textContent' },
			sessionId,
		});
		await started.promise;
		await f.manager.setSharing(pageId, []);
		await command;
		assert.match((messages.at(-1) as CDPResponse).error!.message, /BrowserSharingRevoked/);
		assert.equal(
			messages.some(message => 'method' in message && message.method === 'Target.detachedFromTarget'),
			true,
		);
		finish.resolve();
		await groups.sendCDPMessage(id, { id: 3, method: 'Target.getTargets' });
		assert.deepEqual((messages.at(-1) as CDPResponse).result, { targetInfos: [] });
		assert.equal(
			messages.some(message => 'result' in message && (message.result as { secret?: string } | undefined)?.secret),
			false,
		);
		await f.manager.loadURL(pageId, 'https://example.test/still-private');
		assert.equal((await f.manager.getState(pageId)).url, 'https://example.test/still-private');
	});

	test('workspace pages remain private even when selected explicitly', async () => {
		using f = fixture();
		const id = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'about:blank',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		await assert.rejects(groups.createGroup({ sandboxSessionId: 'one', browserIds: [id] }), /BrowserTargetAccessDenied/);
	});
});
