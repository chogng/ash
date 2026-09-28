import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import type { IConfigurationApi } from '../../../configuration/common/configurationIpc.js';
import { AppServerDictationService } from '../../browser/appServerDictationService.js';

type Notification = Parameters<Parameters<AppServerProtocolClient['onNotification']>[0]>[0];
type ConnectionState = Parameters<Parameters<AppServerProtocolClient['onStateChange']>[0]>[0];

class Client {
	state: ConnectionState = 'ready';
	stopText: string | null = null;
	readonly requests: { method: string; resourceId: string; backend?: unknown }[] = [];
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

	async request(method: { method: string }, params: { resourceId: string; backend?: unknown }): Promise<{ text: string | null }> {
		this.requests.push({ method: method.method, resourceId: params.resourceId, ...(params.backend ? { backend: params.backend } : {}) });
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

function configuration(source = '{}\n'): IConfigurationApi {
	return { read: async () => ({ revision: 1, document: { version: 1, source } }) } as IConfigurationApi;
}

test('dictation delivers only its own phrases and closes on disconnect', async () => {
	const client = new Client();
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient, configuration());
	const phrases: string[] = [];
	const ended: string[] = [];
	const session = await service.start(text => phrases.push(text), error => ended.push(error ?? 'ended'));
	const resourceId = client.requests[0]!.resourceId;
	assert.equal(client.requests[0]!.method, 'dictation/start');
	assert.deepEqual(client.requests[0]!.backend, { type: 'local', modelId: 'paraformer-large-online-ec6a3c64' });
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
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient, configuration());
	const phrases: string[] = [];
	const session = await service.start(text => phrases.push(text), () => {});
	const resourceId = client.requests[0]!.resourceId;
	await session.stop();
	assert.deepEqual(client.requests[1], { method: 'dictation/stop', resourceId });
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'late', isFinal: true } });
	assert.deepEqual(phrases, []);
});

test('stop response delivers final text when the notification arrives after the response', async () => {
	const client = new Client();
	client.stopText = 'final phrase';
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient, configuration());
	const phrases: string[] = [];
	const session = await service.start((text, isFinal) => { if (isFinal) { phrases.push(text); } }, () => {});
	const resourceId = client.requests[0]!.resourceId;
	await session.stop();
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'final phrase', isFinal: true } });
	assert.deepEqual(phrases, ['final phrase']);
});

test('dictation uses the selected local model package', async () => {
	const client = new Client();
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient, configuration('{"dictation.localModel":"custom-online"}'));
	const session = await service.start(() => {}, () => {});
	assert.deepEqual(client.requests[0]!.backend, { type: 'local', modelId: 'custom-online' });
	await session.stop();
});

test('cloud dictation selects the dedicated streaming transcription model', async () => {
	const client = new Client();
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient, configuration('{"dictation.backend":"cloud"}'));
	const updates: { text: string; isFinal: boolean }[] = [];
	const session = await service.start((text, isFinal) => updates.push({ text, isFinal }), () => {});
	assert.deepEqual(client.requests[0]!.backend, { type: 'cloud', modelId: 'gpt-live-transcribe' });
	const resourceId = client.requests[0]!.resourceId;
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'partial', isFinal: false } });
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'complete', isFinal: true } });
	assert.deepEqual(updates, [{ text: 'partial', isFinal: false }, { text: 'complete', isFinal: true }]);
	await session.stop();
});
