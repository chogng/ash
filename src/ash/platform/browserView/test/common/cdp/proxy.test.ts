import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CDPBrowserProxy } from '../../../common/cdp/proxy.js';
import type { CDPEvent, CDPResponse, CDPTargetEvent, CDPTargetInfo, ICDPBrowserHost } from '../../../common/cdp/types.js';

function fixture() {
	const store = new DisposableStore();
	const events = store.add(new Emitter<CDPTargetEvent>());
	const targets = new Map<string, CDPTargetInfo>();
	const commands: Array<{ targetId: string; method: string; params: Record<string, unknown>; sessionId?: string; }> = [];
	const browser: CDPTargetInfo = { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false, browserContextId: 'context' };
	const getTarget = (id: string): CDPTargetInfo => {
		const target = targets.get(id);
		if (!target) { throw new Error('BrowserTargetAccessDenied'); }
		return target;
	};
	const host: ICDPBrowserHost = {
		targetInfo: browser,
		onTargetEvent: events.event,
		whenReady: async () => { },
		getTargets: () => [...targets.values()],
		getTargetInfo: getTarget,
		getVersion: () => ({ protocolVersion: '1.3', product: 'Chrome/test', revision: '', userAgent: 'Chrome/test', jsVersion: 'test' }),
		getWindowForTarget: id => {
			getTarget(id);
			return { windowId: 1, bounds: { left: 0, top: 0, width: 640, height: 480, windowState: 'normal' } };
		},
		getBrowserContexts: () => ['context'],
		createBrowserContext: () => 'new-context',
		disposeBrowserContext: async () => { },
		createTarget: async url => add('created-page', url),
		activateTarget: id => { getTarget(id); },
		closeTarget: async id => {
			getTarget(id);
			targets.delete(id);
			events.fire({ type: 'destroyed', targetId: id });
		},
		sendCommand: async (targetId, method, params, sessionId) => {
			getTarget(targetId);
			commands.push({ targetId, method, params, sessionId });
			return { value: 2 };
		},
	};
	function add(id: string, url = 'about:blank'): CDPTargetInfo {
		const target = { ...browser, targetId: id, type: 'page', url, attached: false };
		targets.set(id, target);
		events.fire({ type: 'created', targetInfo: target });
		return target;
	}
	const proxy = store.add(new CDPBrowserProxy(host));
	const messages: Array<CDPEvent | CDPResponse> = [];
	store.add(proxy.onMessage(message => messages.push(message)));
	return { [Symbol.dispose]: () => store.dispose(), proxy, host, targets, events, messages, commands, add };
}

suite('CDP browser proxy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('detaching a browser retires its nested sessions while another browser keeps discovering and attaching', async () => {
		using f = fixture();
		f.add('page-one');
		const first = (await f.proxy.sendCommand('Target.attachToBrowserTarget') as { sessionId: string; }).sessionId;
		const nested = (await f.proxy.sendCommand('Target.attachToBrowserTarget', {}, first) as { sessionId: string; }).sessionId;
		const second = (await f.proxy.sendCommand('Target.attachToBrowserTarget') as { sessionId: string; }).sessionId;
		for (const sessionId of [nested, second]) {
			await f.proxy.sendCommand('Target.setDiscoverTargets', { discover: true }, sessionId);
			await f.proxy.sendCommand('Target.setAutoAttach', { autoAttach: true, flatten: true }, sessionId);
			await f.proxy.sendCommand('Target.setAutoAttach', { autoAttach: true, flatten: true }, sessionId);
		}
		assert.deepEqual(f.messages.filter(message => 'method' in message && message.method === 'Target.attachedToTarget').map(message => message.sessionId), [nested, second]);
		await f.proxy.sendCommand('Target.detachFromTarget', { sessionId: first });
		assert.equal(f.messages.filter(message => 'method' in message && message.method === 'Target.detachedFromTarget').length, 1);
		await f.proxy.sendMessage({ id: 1, method: 'Target.getTargets', sessionId: nested });
		assert.deepEqual(f.messages.at(-1), { id: 1, sessionId: nested, error: { code: -32000, message: 'BrowserCDPSessionUnavailable' } });
		f.messages.length = 0;
		f.add('page-two');
		assert.deepEqual(f.messages.filter(message => 'method' in message).map(message => [message.method, message.sessionId]), [
			['Target.targetCreated', second], ['Target.attachedToTarget', second],
		]);
		const target = f.targets.get('page-two')!;
		const changed = { ...target, title: 'New title' };
		f.targets.set(target.targetId, changed);
		f.events.fire({ type: 'changed', targetInfo: changed });
		assert.deepEqual(f.messages.at(-1), { method: 'Target.targetInfoChanged', params: { targetInfo: { ...changed, attached: true } }, sessionId: second });
		await f.proxy.sendCommand('Target.closeTarget', { targetId: target.targetId });
		assert.deepEqual(f.messages.at(-1), { method: 'Target.targetDestroyed', params: { targetId: target.targetId }, sessionId: second });
		f.proxy.dispose();
		assert.equal(f.targets.has('page-one'), true);
	});

	test('maps Chromium child sessions for commands and events and retires them with their page', async () => {
		using f = fixture();
		f.add('page');
		const parent = (await f.proxy.sendCommand('Target.attachToTarget', { targetId: 'page', flatten: true }) as { sessionId: string; }).sessionId;
		await f.proxy.sendCommand('Target.setAutoAttach', { autoAttach: true, flatten: true }, parent);
		const childInfo = { ...f.targets.get('page')!, targetId: 'frame', type: 'iframe' };
		f.events.fire({ type: 'message', targetId: 'page', message: { method: 'Target.attachedToTarget', params: { sessionId: 'chromium-child', targetInfo: childInfo, waitingForDebugger: false } } });
		const child = ((f.messages.at(-1) as CDPEvent).params as { sessionId: string; }).sessionId;
		assert.notEqual(child, 'chromium-child');
		assert.deepEqual(f.messages.at(-1), { method: 'Target.attachedToTarget', params: { sessionId: child, targetInfo: childInfo, waitingForDebugger: false }, sessionId: parent });
		await f.proxy.sendMessage({ id: 2, method: 'Runtime.evaluate', params: { expression: '1 + 1' }, sessionId: child });
		assert.deepEqual(f.commands.at(-1), { targetId: 'page', method: 'Runtime.evaluate', params: { expression: '1 + 1' }, sessionId: 'chromium-child' });
		assert.deepEqual(f.messages.at(-1), { id: 2, result: { value: 2 }, sessionId: child });
		f.events.fire({ type: 'message', targetId: 'page', message: { method: 'Runtime.consoleAPICalled', params: { value: 'hello' }, sessionId: 'chromium-child' } });
		assert.deepEqual(f.messages.at(-1), { method: 'Runtime.consoleAPICalled', params: { value: 'hello' }, sessionId: child });
		const control = (await f.proxy.sendCommand('Target.attachToTarget', { targetId: 'frame', flatten: true }) as { sessionId: string; }).sessionId;
		await f.proxy.sendCommand('Runtime.terminateExecution', {}, control);
		assert.deepEqual(f.commands.at(-1), { targetId: 'page', method: 'Runtime.terminateExecution', params: {}, sessionId: 'chromium-child' });
		assert.deepEqual(await f.proxy.sendCommand('Target.getTargetInfo', {}, control), { targetInfo: { ...childInfo, attached: true } });
		await assert.rejects(f.proxy.sendCommand('Target.attachToTarget', { targetId: 'unshared-frame', flatten: true }), /BrowserTargetAccessDenied/);
		await f.proxy.sendCommand('Target.detachFromTarget', { sessionId: control });
		await f.proxy.sendCommand('Runtime.evaluate', {}, child);
		f.events.fire({ type: 'message', targetId: 'page', message: { method: 'Target.detachedFromTarget', params: { sessionId: 'chromium-child', targetId: 'frame' } } });
		assert.deepEqual(f.messages.at(-1), { method: 'Target.detachedFromTarget', params: { sessionId: child, targetId: 'frame' }, sessionId: parent });
		await f.proxy.sendCommand('Runtime.evaluate', { expression: '2 + 2' }, parent);
		assert.equal(f.commands.at(-1)?.targetId, 'page');
		await f.proxy.sendCommand('Target.closeTarget', { targetId: 'page' });
		await f.proxy.sendMessage({ id: 3, method: 'Runtime.evaluate', sessionId: child });
		assert.deepEqual(f.messages.at(-1), { id: 3, sessionId: child, error: { code: -32000, message: 'BrowserCDPSessionUnavailable' } });
	});

	test('reports protocol errors separately from host access failures', async () => {
		using f = fixture();
		for (const [id, method, params, code] of [
			[1, 'Unknown.command', {}, -32601],
			[2, 'Target.getTargets', null, -32602],
			[3, 'Target.attachToTarget', { targetId: 5, flatten: true }, -32602],
			[4, 'Target.setAutoAttach', { autoAttach: true, flatten: false }, -32602],
			[5, 'Target.setDiscoverTargets', { discover: 'yes' }, -32602],
			[6, 'Target.attachToTarget', { targetId: 'private', flatten: true }, -32000],
		] as const) {
			await f.proxy.sendMessage({ id, method, params });
			const response = f.messages.at(-1) as CDPResponse;
			assert.equal(response.id, id);
			assert.equal(response.error?.code, code);
			assert.equal(response.result, undefined);
		}
		assert.equal((f.messages.at(-1) as CDPResponse).error?.message, 'BrowserTargetAccessDenied');
	});

	test('closing during discovery prevents a queued command from reaching the host', async () => {
		using f = fixture();
		const started = promiseWithResolvers<void>();
		const ready = promiseWithResolvers<void>();
		f.host.whenReady = async () => { started.resolve(); await ready.promise; };
		let queried = false;
		f.host.getTargets = () => { queried = true; return []; };
		const command = f.proxy.sendMessage({ id: 1, method: 'Target.getTargets' });
		await started.promise;
		f.proxy.dispose();
		ready.resolve();
		await command;
		assert.equal(queried, false);
		assert.deepEqual(f.messages, []);
	});
});
