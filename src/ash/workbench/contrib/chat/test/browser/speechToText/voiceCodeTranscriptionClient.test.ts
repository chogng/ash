import assert from 'node:assert/strict';
import { test } from 'mocha';
import '../../../browser/chat.shared.contribution.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { toDisposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { AppServerProtocolClient } from '../../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { createAppServerVoiceCodeTranscriptionBackend } from '../../../../../../platform/renderer/browser/appServerVoiceCodeTranscriptionBackend.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../../platform/renderer/common/dictation.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { TestConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient, type IVoiceCodeTranscription } from '../../../browser/speechToText/voiceCodeTranscriptionClient.js';

ensureNoDisposablesAreLeakedInTestSuite();

type Notification = Parameters<Parameters<AppServerProtocolClient['onNotification']>[0]>[0];
type ConnectionState = Parameters<Parameters<AppServerProtocolClient['onStateChange']>[0]>[0];
interface Request { method: string; params: { resourceId: string;[key: string]: unknown; }; }
class Connection {
	state: ConnectionState = 'ready';
	readonly requests: Request[] = [];
	readonly notifications = new Set<(notification: Notification) => void>();
	readonly states = new Set<(state: ConnectionState) => void>();
	readonly waiters = new Set<(request: Request) => void>();
	startGate: Promise<void> = Promise.resolve();
	stopGate: Promise<void> = Promise.resolve();
	stopText: string | null = 'final';
	onCancel: () => void = () => { };
	onStop: (resourceId: string) => void = () => { };
	onNotification(listener: (notification: Notification) => void) { this.notifications.add(listener); return toDisposable(() => this.notifications.delete(listener)); }
	onStateChange(listener: (state: ConnectionState) => void) { this.states.add(listener); return toDisposable(() => this.states.delete(listener)); }
	async request(method: { method: string; }, params: Request['params']): Promise<unknown> {
		const request = { method: method.method, params };
		this.requests.push(request);
		for (const listener of this.waiters) listener(request);
		if (method.method === 'dictation/start') await this.startGate;
		if (method.method === 'dictation/stop') { this.onStop(params.resourceId); await this.stopGate; return { text: this.stopText }; }
		if (method.method === 'dictation/cancel') this.onCancel();
		if (method.method === 'dictation/options') return { inputDevices: [], languages: ['en', 'zh'] };
		return null;
	}
	whenRequest(method: string): Promise<Request> {
		const existing = this.requests.find(request => request.method === method);
		if (existing) return Promise.resolve(existing);
		return new Promise(resolve => {
			const listener = (request: Request) => { if (request.method === method) { this.waiters.delete(listener); resolve(request); } };
			this.waiters.add(listener);
		});
	}
	emit(event: Notification): void { for (const listener of this.notifications) listener(event); }
	disconnect(): void { this.state = 'crashed'; for (const listener of this.states) listener(this.state); }
}

function fixture(owner: DisposableStore, connection: Connection, source = '{"dictation.backend":"cloud","dictation.inputDevice":"mic-2","dictation.language":"zh"}') {
	const services = owner.add(new InstantiationService());
	services.registerInstance(IVoiceCodeTranscriptionBackendService, createAppServerVoiceCodeTranscriptionBackend(connection as unknown as AppServerProtocolClient));
	services.registerSingleton(IConfigurationService, () => new TestConfigurationService({ source }));
	services.registerSingleton(IVoiceCodeTranscriptionClient, () => services.createInstance(VoiceCodeTranscriptionClient));
	return { services, client: services.get(IVoiceCodeTranscriptionClient) };
}
async function open(client: IVoiceCodeTranscriptionClient) { await client.connect({} as Window & typeof globalThis, ''); await client.startSession(); }
function finalText(owner: DisposableStore, client: IVoiceCodeTranscriptionClient): Promise<IVoiceCodeTranscription> {
	return new Promise(resolve => owner.add(client.onTranscription(event => { if (event.status === 'final') resolve(event); })));
}

test('production DI shares one transcription client and missing host registration fails', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const { services, client } = fixture(owner, connection);
	const child = owner.add(services.createChild());
	assert.equal(child.get(IVoiceCodeTranscriptionClient), client);
	await open(client);
	assert.equal(client.isConnected, true);
	using missing = new InstantiationService();
	missing.registerSingleton(IConfigurationService, () => new TestConfigurationService());
	assert.throws(() => missing.createInstance(VoiceCodeTranscriptionClient), /voiceCodeTranscriptionBackendService/);
});

test('PTT preserves start audio end ordering over the host PCM contract', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const { client } = fixture(owner, connection);
	await open(client);
	const result = finalText(owner, client);
	client.sendPttStart('spoken-turn');
	client.sendPttAudioChunk('spoken-turn', 'AAE=');
	client.sendPttEnd('spoken-turn');
	assert.equal((await result).text, 'final');
	assert.deepEqual(connection.requests.map(request => request.method), ['dictation/start', 'dictation/audio', 'dictation/stop']);
	const resourceId = connection.requests[0].params.resourceId;
	assert.deepEqual(connection.requests[0].params, { resourceId, backend: { type: 'cloud', provider: 'openAi', modelId: 'gpt-live-transcribe' }, language: 'zh', inputDevice: null, audioInput: 'pcm16' });
	assert.deepEqual(connection.requests[1].params, { resourceId, audio: 'AAE=' });
});

test('concurrent session initialization admits one resource and early host errors release it', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const gate = new DeferredPromise<void>(); connection.startGate = gate.p;
	const { client } = fixture(owner, connection);
	await client.connect({} as Window & typeof globalThis, '');
	const starting = client.startSession();
	const failed = assert.rejects(starting, /recognizer failed/);
	await assert.rejects(client.startSession(), /already active/);
	const { params: { resourceId } } = await connection.whenRequest('dictation/start');
	connection.emit({ method: 'dictation/ended', params: { resourceId, error: 'recognizer failed' } });
	await gate.complete(); await failed;
	assert.deepEqual(connection.requests.map(request => request.method), ['dictation/start', 'dictation/cancel']);
	assert.throws(() => client.sendPttStart('late'), /not initialized/);
});

test('only owned transcripts receive increasing revisions and committed final text', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const { client } = fixture(owner, connection);
	const events: IVoiceCodeTranscription[] = [];
	owner.add(client.onTranscription(event => events.push(event)));
	await open(client); client.sendPttStart('turn');
	const { params: { resourceId } } = await connection.whenRequest('dictation/start');
	connection.emit({ method: 'dictation/transcript', params: { resourceId: 'other', text: 'foreign', isFinal: false } });
	connection.emit({ method: 'dictation/transcript', params: { resourceId, text: 'write', isFinal: false } });
	connection.emit({ method: 'dictation/transcript', params: { resourceId, text: 'write a', isFinal: false } });
	const final = finalText(owner, client); client.sendPttEnd('turn'); await final;
	assert.deepEqual(events, [
		{ turnId: 'turn', text: 'write', status: 'partial', revision: 1, committed: '' },
		{ turnId: 'turn', text: 'write a', status: 'partial', revision: 2, committed: '' },
		{ turnId: 'turn', text: 'final', status: 'final', revision: 3, committed: 'final' },
	]);
});

test('stop acknowledges backend release before publishing one final transcript', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const gate = new DeferredPromise<void>(); connection.stopGate = gate.p;
	const { client } = fixture(owner, connection);
	const events: IVoiceCodeTranscription[] = [];
	owner.add(client.onTranscription(event => events.push(event)));
	await open(client); client.sendPttStart('turn');
	const { params: { resourceId } } = await connection.whenRequest('dictation/start');
	connection.onStop = () => {
		connection.emit({ method: 'dictation/transcript', params: { resourceId, text: 'final', isFinal: true } });
		connection.emit({ method: 'dictation/ended', params: { resourceId, error: null } });
	};
	const final = finalText(owner, client); client.sendPttEnd('turn');
	await connection.whenRequest('dictation/stop');
	assert.deepEqual(events, []);
	await gate.complete(); await final;
	connection.emit({ method: 'dictation/transcript', params: { resourceId, text: 'late', isFinal: true } });
	assert.equal(events.length, 1);
});

test('stop retains backend errors and never publishes failed text', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const { client } = fixture(owner, connection);
	const events: IVoiceCodeTranscription[] = [];
	owner.add(client.onTranscription(event => events.push(event)));
	const failure = new Promise<string>(resolve => owner.add(client.onError(error => resolve(error.detail))));
	await open(client); client.sendPttStart('turn');
	connection.onStop = resourceId => connection.emit({ method: 'dictation/ended', params: { resourceId, error: 'capture failed' } });
	client.sendPttEnd('turn');
	assert.match(await failure, /capture failed/);
	assert.deepEqual(events, []);
});

test('disconnect during acquisition cancels both the pending and late accepted resource', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const gate = new DeferredPromise<void>(); connection.startGate = gate.p;
	const { client } = fixture(owner, connection);
	await client.connect({} as Window & typeof globalThis, '');
	const initializing = client.startSession();
	const cancelled = assert.rejects(initializing, isCancellationError);
	const first = await connection.whenRequest('dictation/start');
	client.disconnect(); await gate.complete();
	await cancelled;
	await client.connect({} as Window & typeof globalThis, '');
	assert.deepEqual(connection.requests.filter(request => request.method === 'dictation/cancel').map(request => request.params.resourceId), [first.params.resourceId, first.params.resourceId]);
});

test('disconnect interrupts a subscription upload and suppresses its late transcript', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const gate = new DeferredPromise<void>(); connection.stopGate = gate.p;
	connection.onCancel = () => { void gate.complete(); };
	const { client } = fixture(owner, connection, '{"dictation.backend":"codex"}');
	const events: IVoiceCodeTranscription[] = [];
	owner.add(client.onTranscription(event => events.push(event)));
	await open(client); client.sendPttStart('turn'); client.sendPttEnd('turn');
	await connection.whenRequest('dictation/stop'); client.disconnect();
	await client.connect({} as Window & typeof globalThis, '');
	assert.deepEqual(connection.requests[0].params.backend, { type: 'codex' });
	assert.deepEqual(events, []);
});

test('connection loss closes before reporting its error and disposal detaches listeners', async () => {
	using owner = new DisposableStore();
	const connection = new Connection();
	const { client } = fixture(owner, connection);
	const events: string[] = [];
	owner.add(client.onDidClose(code => events.push('close:' + code)));
	owner.add(client.onError(error => events.push(error.terminal ? 'terminal' : 'recoverable')));
	await open(client); client.sendPttStart('turn'); await connection.whenRequest('dictation/start');
	connection.disconnect();
	assert.deepEqual(events, ['close:1006', 'terminal']);
	assert.equal(client.isConnected, false);
	owner.dispose();
	assert.equal(connection.notifications.size + connection.states.size, 0);
});

test('empty final text is an explicit completed turn', async () => {
	using owner = new DisposableStore();
	const connection = new Connection(); connection.stopText = '';
	const { client } = fixture(owner, connection);
	await open(client); const final = finalText(owner, client);
	client.sendPttStart('turn'); client.sendPttEnd('turn');
	assert.deepEqual(await final, { turnId: 'turn', text: '', status: 'final', revision: 1, committed: '' });
});
