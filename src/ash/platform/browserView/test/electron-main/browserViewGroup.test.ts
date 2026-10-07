import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserViewGroupMainService } from '../../electron-main/browserViewGroupMainService.js';
import { BrowserViewStorageScope } from '../../common/browserView.js';
import type { CDPEvent, CDPResponse } from '../../common/cdp/types.js';
import { fixture } from './browserView.test.js';
import { promiseWithResolvers } from '../../../../base/common/async.js';

suite('Browser view groups', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('automatic attachments belong to the browser session that requested them', async () => {
		using f = fixture();
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const id = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		const parents: string[] = [];
		for (const commandId of [1, 2]) {
			await groups.sendCDPMessage(id, { id: commandId, method: 'Target.attachToBrowserTarget' });
			parents.push(((messages.at(-1) as CDPResponse).result as { sessionId: string; }).sessionId);
		}
		for (const sessionId of parents) {
			await groups.sendCDPMessage(id, { id: 3, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true }, sessionId });
		}
		await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		await groups.sendCDPMessage(id, { id: 4, method: 'Target.getTargets' });
		assert.deepEqual(messages.filter(message => 'method' in message && message.method === 'Target.attachedToTarget').map(message => message.sessionId), parents);
		await groups.sendCDPMessage(id, { id: 5, method: 'Target.setAutoAttach', params: { autoAttach: false, flatten: true }, sessionId: parents[0] });
		assert.equal(messages.filter(message => 'method' in message && message.method === 'Target.detachedFromTarget').length, 1);
		messages.length = 0;
		await f.manager.createTarget('about:blank', 'one', new AbortController().signal);
		await groups.sendCDPMessage(id, { id: 6, method: 'Target.getTargets' });
		assert.deepEqual(messages.filter(message => 'method' in message && message.method === 'Target.attachedToTarget').map(message => message.sessionId), [parents[1]]);
	});

	test('CDP creation returns Chromium identity and cannot add targets to a fixed selection', async () => {
		using f = fixture();
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const id = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		await groups.sendCDPMessage(id, { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
		const page = (await f.manager.getBrowserViews())[0]!;
		assert.deepEqual((messages.at(-1) as CDPResponse).result, { targetId: await f.manager.tryGetBrowserView(page.id)!.debugger.getTargetId() });
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
			started.resolve(); await finish.promise;
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
		assert.deepEqual((messages.at(-1) as CDPResponse).result, { targetInfos: [{ targetId: await first.debugger.getTargetId(), browserViewId: first.id, type: 'page', title: 'Example', url: 'about:blank', attached: false, canAccessOpener: false, browserContextId: first.session.id }] });
		await groups.sendCDPMessage(id, { id: 2, method: 'Target.attachToTarget', params: { targetId: other.id, flatten: true } });
		assert.match((messages.at(-1) as CDPResponse).error!.message, /BrowserTargetAccessDenied/);
		await groups.sendCDPMessage(id, { id: 3, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
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
		await groups.sendCDPMessage(first, { id: 1, method: 'Target.attachToTarget', params: { targetId: page.id, flatten: true } });
		const sessionId = ((messages.at(-1) as CDPResponse).result as { sessionId: string; }).sessionId;
		await groups.sendCDPMessage(second, { id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
		await groups.sendCDPMessage(first, { id: 3, method: 'Runtime.evaluate', params: { expression: '1 + 1' }, sessionId });
		assert.equal(f.commands.at(-1)?.method, 'Runtime.evaluate');
		await groups.sendCDPMessage(first, { id: 4, method: 'Target.getTargets', sessionId });
		assert.deepEqual(((messages.at(-1) as CDPResponse).result as { targetInfos: { browserViewId: string; }[]; }).targetInfos.map(info => info.browserViewId), [page.id]);
		page.webContents.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { value: 'one' }, '');
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
		f.command = async () => { await new Promise<void>(resolve => { finish = resolve; }); return {}; };
		const chromium = page.debugger.sendCommand('Runtime.evaluate');
		await assert.rejects(page.runOperation(new AbortController().signal, async () => { throw new Error('IPC connection closed'); }), /IPC connection closed/);
		let navigated = false;
		f.load = async url => { navigated = true; f.url = url; };
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
		await f.manager.getOrCreateBrowserView(pageId, { initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace } });
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		const id = await groups.createGroup({ sandboxSessionId: 'one' });
		const messages: Array<CDPEvent | CDPResponse> = [];
		f.store.add(groups.onDynamicCDPMessage(id)(message => messages.push(message)));
		await f.manager.setSharing(pageId, ['one']);
		await groups.sendCDPMessage(id, { id: 1, method: 'Target.attachToTarget', params: { targetId: pageId, flatten: true } });
		const sessionId = ((messages.at(-1) as CDPResponse).result as { sessionId: string; }).sessionId;
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.command = async () => { started.resolve(); await finish.promise; return { secret: 'signed-in content' }; };
		const command = groups.sendCDPMessage(id, { id: 2, method: 'Runtime.evaluate', params: { expression: 'document.body.textContent' }, sessionId });
		await started.promise;
		await f.manager.setSharing(pageId, []);
		await command;
		assert.match((messages.at(-1) as CDPResponse).error!.message, /BrowserSharingRevoked/);
		assert.equal(messages.some(message => 'method' in message && message.method === 'Target.detachedFromTarget'), true);
		finish.resolve();
		await groups.sendCDPMessage(id, { id: 3, method: 'Target.getTargets' });
		assert.deepEqual((messages.at(-1) as CDPResponse).result, { targetInfos: [] });
		assert.equal(messages.some(message => 'result' in message && (message.result as { secret?: string; } | undefined)?.secret), false);
		await f.manager.loadURL(pageId, 'https://example.test/still-private');
		assert.equal((await f.manager.getState(pageId)).url, 'https://example.test/still-private');
	});

	test('workspace pages remain private even when selected explicitly', async () => {
		using f = fixture();
		const id = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
		await f.manager.getOrCreateBrowserView(id, { initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace } });
		const groups = f.store.add(f.instantiation.createInstance(BrowserViewGroupMainService));
		await assert.rejects(groups.createGroup({ sandboxSessionId: 'one', browserIds: [id] }), /BrowserTargetAccessDenied/);
	});
});
