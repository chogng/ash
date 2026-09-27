import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import { AppServerDictationService } from '../../browser/appServerDictationService.js';

type Notification = Parameters<Parameters<AppServerProtocolClient['onNotification']>[0]>[0];
type ConnectionState = Parameters<Parameters<AppServerProtocolClient['onStateChange']>[0]>[0];

class Client {
	state: ConnectionState = 'ready';
	readonly requests: { method: string; resourceId: string }[] = [];
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

	async request(method: { method: string }, params: { resourceId: string }): Promise<void> {
		this.requests.push({ method: method.method, resourceId: params.resourceId });
	}

	emit(notification: Notification): void {
		for (const listener of this.notifications) listener(notification);
	}

	changeState(state: ConnectionState): void {
		this.state = state;
		for (const listener of this.states) listener(state);
	}
}

test('dictation delivers only its own phrases and closes on disconnect', async () => {
	const client = new Client();
	using service = new AppServerDictationService(client as unknown as AppServerProtocolClient);
	const phrases: string[] = [];
	const ended: string[] = [];
	const session = await service.start(text => phrases.push(text), error => ended.push(error ?? 'ended'));
	const resourceId = client.requests[0]!.resourceId;
	assert.equal(client.requests[0]!.method, 'dictation/start');
	client.emit({ method: 'dictation/transcript', params: { resourceId: 'other', text: 'ignored' } });
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'recognized' } });
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
	const session = await service.start(text => phrases.push(text), () => {});
	const resourceId = client.requests[0]!.resourceId;
	await session.stop();
	assert.deepEqual(client.requests[1], { method: 'dictation/stop', resourceId });
	client.emit({ method: 'dictation/transcript', params: { resourceId, text: 'late' } });
	assert.deepEqual(phrases, []);
});
