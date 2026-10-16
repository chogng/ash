import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { AppServerDictationService } from '../../browser/appServerDictationService.js';

const options = { backend: { type: 'cloud', provider: 'openAi', modelId: 'gpt-live-transcribe' }, inputDevice: 'mic-2', language: 'zh' } as const;

type Notification = Parameters<Parameters<AppServerProtocolClient['onNotification']>[0]>[0];
type ConnectionState = Parameters<Parameters<AppServerProtocolClient['onStateChange']>[0]>[0];

class Client {
	state: ConnectionState = 'ready';
	stopText: string | null = null;
	readonly requests: { method: string; resourceId: string; backend?: unknown; inputDevice?: string | null; language?: string | null; }[] = [];
	private readonly notifications = new Set<(notification: Notification) => void>();
	private readonly states = new Set<(state: ConnectionState) => void>();

	onNotification(listener: (notification: Notification) => void) {
		this.notifications.add(listener);
		return toDisposable(() => this.notifications.delete(listener));
	}

	onStateChange(listener: (state: ConnectionState) => void) {
		this.states.add(listener);
		return toDisposable(() => this.states.delete(listener));
	}

	async request(method: { method: string; }, params: { resourceId: string; backend?: unknown; }): Promise<unknown> {
		this.requests.push({ method: method.method, ...params });
		if (method.method === 'dictation/options') return { inputDevices: [{ id: 'mic-2', label: 'USB microphone', isDefault: false }], languages: ['en', 'zh'] };
		return { text: method.method === 'dictation/stop' ? this.stopText : null };
	}

	emit(notification: Notification): void {
		for (const listener of this.notifications) listener(notification);
	}

	changeState(state: ConnectionState): void {
		this.state = state;
		for (const listener of this.states) listener(state);
	}
}

test('concurrent dictation starts cannot replace capture while its backend is starting', async () => {
	const client = new Client();
	const started = new DeferredPromise<void>();
	const request = client.request.bind(client);
	client.request = async (method, params) => {
		const result = await request(method, params);
		if (method.method === 'dictation/start') await started.p;
		return result;
	};
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const first = service.start(options, () => { }, () => { });
	await assert.rejects(service.start(options, () => { }, () => { }), /already active/);
	await started.complete();
	const session = await first;
	await session.stop();
	assert.deepEqual(client.requests.map(request => request.method), ['dictation/start', 'dictation/stop']);
});


test('dictation delivers only its own phrases and closes on disconnect', async () => {
	const client = new Client();
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const phrases: string[] = [];
	const ended: string[] = [];
	const session = await service.start(options, text => phrases.push(text), error => ended.push(error ?? 'ended'));
	const resourceId = client.requests[0]!.resourceId;
	assert.equal(client.requests[0]!.method, 'dictation/start');
	assert.deepEqual(client.requests[0]!.backend, options.backend);
	client.emit({ method: 'dictation/transcript', params: { resourceId: 'other', text: 'ignored', isFinal: true } });
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'recognized', isFinal: true } });
	assert.deepEqual(phrases, ['recognized']);
	client.changeState('crashed');
	assert.deepEqual(ended, ['Dictation connection lost']);
	await session.stop();
	assert.equal(client.requests.length, 1);
});


test('dictation stop releases the session and ignores late phrases', async () => {
	const client = new Client();
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const phrases: string[] = [];
	const session = await service.start(options, text => phrases.push(text), () => { });
	const resourceId = client.requests[0]!.resourceId;
	await session.stop();
	assert.deepEqual(client.requests[1], { method: 'dictation/stop', resourceId });
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'late', isFinal: true } });
	assert.deepEqual(phrases, []);
});


test('stop response delivers final text when the notification arrives after the response', async () => {
	const client = new Client();
	client.stopText = 'final phrase';
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const phrases: string[] = [];
	const session = await service.start(options, (text, isFinal) => { if (isFinal) { phrases.push(text); } }, () => { });
	const resourceId = client.requests[0]!.resourceId;
	await session.stop();
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'final phrase', isFinal: true } });
	assert.deepEqual(phrases, ['final phrase']);
});


test('cancelling Codex upload interrupts stop and ignores its late result', async () => {
	const client = new Client(); client.stopText = 'discard this';
	const stop = new DeferredPromise<void>();
	const request = client.request.bind(client);
	client.request = async (method, params) => {
		const result = await request(method, params);
		if (method.method === 'dictation/stop') { await stop.p; }
		if (method.method === 'dictation/cancel') { await stop.complete(); }
		return result;
	};
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const phrases: string[] = [];
	const session = await service.start(options, text => phrases.push(text), () => { });
	const stopped = session.stop();
	await session.cancel(); await stopped;
	assert.deepEqual(client.requests.map(request => request.method), ['dictation/start', 'dictation/stop', 'dictation/cancel']);
	assert.deepEqual(phrases, []);
});


test('RPC adapter forwards explicit options without selecting a product backend', async () => {
	const client = new Client();
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.getOptions({ type: 'codex' }), { inputDevices: [{ id: 'mic-2', label: 'USB microphone', isDefault: false }], languages: ['en', 'zh'] });
	const session = await service.start(options, () => { }, () => { });
	assert.deepEqual(client.requests[0], { method: 'dictation/options', backend: { type: 'codex' } });
	assert.deepEqual(client.requests[1], { method: 'dictation/start', resourceId: client.requests[1]!.resourceId, ...options });
	await session.cancel();
});

test('a final notification and stop response deliver the transcript once', async () => {
	const client = new Client(); client.stopText = 'final';
	const request = client.request.bind(client);
	client.request = async (method, params) => {
		if (method.method === 'dictation/stop') client.emit({ method: 'dictation/transcript', params: { resourceId: params.resourceId, text: 'final', isFinal: true } });
		return request(method, params);
	};
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const phrases: string[] = [];
	const session = await service.start(options, text => phrases.push(text), () => { });
	await session.stop();
	assert.deepEqual(phrases, ['final']);
});

test('disconnect during stop suppresses the old response after publishing the end', async () => {
	const client = new Client();
	client.stopText = 'stale';
	const ready = new DeferredPromise<void>();
	const request = client.request.bind(client);
	client.request = async (method, params) => {
		const result = await request(method, params);
		if (method.method === 'dictation/stop') await ready.p;
		return result;
	};
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const phrases: string[] = [];
	const ended: (string | undefined)[] = [];
	const session = await service.start(options, text => phrases.push(text), error => ended.push(error));
	const stopped = session.stop();
	client.changeState('crashed');
	await ready.complete();
	await stopped;
	assert.deepEqual(phrases, []);
	assert.deepEqual(ended, ['Dictation connection lost']);
});
