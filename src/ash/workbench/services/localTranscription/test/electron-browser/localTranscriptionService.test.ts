import assert from 'node:assert/strict';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import {
	ILocalTranscriptionService,
	ILocalTranscriptionModelService,
	LocalTranscriptionModelState,
	DictationModelState,
	type ILocalTranscriptionResult,
	type IDictationModelStatus,
} from '../../../../../platform/localTranscription/common/localTranscription.js';
import { LocalTranscriptionService, registerLocalTranscriptionService } from '../../electron-browser/localTranscriptionService.js';
import { NullLocalTranscriptionService } from '../../browser/localTranscriptionService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

type Notification = Parameters<Parameters<AppServerProtocolClient['onNotification']>[0]>[0];
type ConnectionState = Parameters<Parameters<AppServerProtocolClient['onStateChange']>[0]>[0];

class Client {
	public state: ConnectionState = 'ready';
	public readonly requests: { readonly method: string; readonly resourceId: string; readonly backend?: unknown }[] = [];
	public readonly accepted = new DeferredPromise<void>();
	public readonly stopped = new DeferredPromise<void>();
	public readonly cancelled = new DeferredPromise<void>();
	public startBarrier?: DeferredPromise<void>;
	public stopBarrier?: DeferredPromise<void>;
	public cancelBarrier?: DeferredPromise<void>;
	public audioBarrier?: DeferredPromise<void>;
	public cacheBarrier?: DeferredPromise<void>;
	public stopText: string | null = 'final text';
	public beforeStop?: () => void;
	public readonly notifications = new Set<(notification: Notification) => void>();
	public readonly states = new Set<(state: ConnectionState) => void>();

	public onNotification(listener: (notification: Notification) => void): IDisposable {
		this.notifications.add(listener);
		return toDisposable(() => this.notifications.delete(listener));
	}

	public onStateChange(listener: (state: ConnectionState) => void): IDisposable {
		this.states.add(listener);
		return toDisposable(() => this.states.delete(listener));
	}

	public async request(method: { readonly method: string }, params: { readonly resourceId: string; readonly backend?: unknown }): Promise<unknown> {
		if (method.method === 'dictation/model/list') {
			await this.cacheBarrier?.p;
			return { models: [], cacheDirectory: 'C:/models', packageVersion: 1 };
		}
		this.requests.push({ method: method.method, ...params });
		if (method.method === 'dictation/cancel') {
			await this.cancelled.complete();
			await this.cancelBarrier?.p;
			return null;
		}
		if (method.method === 'dictation/audio') {
			await this.audioBarrier?.p;
			return null;
		}
		if (method.method === 'dictation/start' || method.method === 'dictation/model/start') {
			await this.accepted.complete();
			await this.startBarrier?.p;
			return null;
		}
		this.beforeStop?.();
		await this.stopped.complete();
		await this.stopBarrier?.p;
		return { text: this.stopText };
	}

	public emit(notification: Notification): void {
		for (const listener of this.notifications) {
			listener(notification);
		}
	}

	public disconnect(): void {
		this.state = 'crashed';
		for (const listener of this.states) {
			listener(this.state);
		}
	}
}

class Fixture extends Disposable {
	public readonly client = new Client();
	public readonly services = this._register(new InstantiationService());
	public readonly service: LocalTranscriptionService;
	public readonly models: ILocalTranscriptionModelService;

	constructor() {
		super();
		const capabilities = registerLocalTranscriptionService(this.services, this.client as unknown as AppServerProtocolClient);
		this.service = this.services.get(ILocalTranscriptionService) as LocalTranscriptionService;
		this.models = this.services.get(ILocalTranscriptionModelService);
		assert.equal(capabilities.localTranscription, this.service);
	}

	public get resourceId(): string {
		return this.client.requests[0]!.resourceId;
	}

	public transcript(text: string, isFinal: boolean, resourceId = this.resourceId): void {
		this.client.emit({ method: 'dictation/transcript', params: { resourceId, text, isFinal } });
	}

	public modelProgress(stage: { type: 'checking' | 'loading' | 'ready' | 'cancelled' } | { type: 'failed'; error: string }, resourceId = this.resourceId): void {
		this.client.emit({
			method: 'dictation/model/progress',
			params: { resourceId, modelId: 'selected-model', stage },
		});
	}
}

suite('LocalTranscriptionService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('canonical transcription and model inventory share the window owner and its managed cache', async () => {
		using fixture = new Fixture();
		assert.equal(fixture.service, fixture.models);
		assert.equal(await fixture.models.getCacheDirectory(), 'C:/models');
		assert.deepEqual(await fixture.service.getModelStatus(), { state: LocalTranscriptionModelState.Idle });
		await assert.rejects(fixture.service.start({ cacheDir: 'C:/another-cache' }), /managed cache/);
		await assert.rejects(fixture.service.start({ cacheDir: 'C:/models', runtimeVersion: 'foundry' }), /runtimeVersion/);
		assert.equal(fixture.client.requests.length, 0);
		await fixture.service.start({ cacheDir: 'C:/models' });
		assert.deepEqual(fixture.client.requests[0]?.backend, {
			type: 'local',
			modelId: 'paraformer-large-online-ec6a3c64',
		});
		await fixture.service.cancel();
	});
	test('cancel before cache admission never starts inference and allows a subsequent recording', async () => {
		using fixture = new Fixture();
		fixture.client.cacheBarrier = new DeferredPromise<void>();
		const starting = assert.rejects(fixture.service.start({ cacheDir: 'C:/models' }), isCancellationError);
		const cancelled = fixture.service.cancel();
		await fixture.client.cacheBarrier.complete();
		await Promise.all([starting, cancelled]);
		assert.deepEqual(fixture.client.requests, []);
		await fixture.service.start({ cacheDir: 'C:/models' });
		await fixture.service.cancel();
	});
	test('canonical import awaits release and reports the backend package revision', async () => {
		using fixture = new Fixture();
		const imported = fixture.service.importModel({ sourcePath: 'C:/prepared', cacheDir: 'C:/models' });
		await fixture.client.accepted.p;
		fixture.modelProgress({ type: 'ready' });
		assert.deepEqual(await imported, { model: 'paraformer-large-online-ec6a3c64', version: 1 });
		assert.equal(fixture.client.requests.at(-1)?.method, 'dictation/model/stop');
	});
	test('stop drains queued renderer audio before releasing the inference session', async () => {
		using fixture = new Fixture();
		await fixture.service.start({ cacheDir: 'C:/models', model: 'selected-model' });
		fixture.client.audioBarrier = new DeferredPromise<void>();
		const packet = fixture.service.pushAudio(VSBuffer.wrap(new Uint8Array([0, 1])));
		const stopping = fixture.service.stop();
		await fixture.client.audioBarrier.complete();
		await packet;
		assert.equal(await stopping, 'final text');
		assert.deepEqual(
			fixture.client.requests.map(request => request.method),
			['dictation/start', 'dictation/audio', 'dictation/stop'],
		);
	});

	test('failed audio rejects stop after releasing the backend and allows a later session', async () => {
		using fixture = new Fixture();
		await fixture.service.start({ cacheDir: 'C:/models', model: 'selected-model' });
		fixture.client.audioBarrier = new DeferredPromise<void>();
		const packet = assert.rejects(fixture.service.pushAudio(VSBuffer.wrap(new Uint8Array([0, 1]))), /audio failed/);
		const stopped = assert.rejects(fixture.service.stop(), /audio failed/);
		await fixture.client.audioBarrier.error(new Error('audio failed'));
		await Promise.all([packet, stopped]);
		assert.equal(fixture.client.requests.at(-1)?.method, 'dictation/stop');
		await fixture.service.start({ cacheDir: 'C:/models', model: 'selected-model' });
		await fixture.service.cancel();
	});
	test('window disposal detaches preparation without sending a backend cancel', async () => {
		using fixture = new Fixture();
		const operation = fixture.models.prepareModel('selected-model', () => {});
		await fixture.client.accepted.p;
		const completion = assert.rejects(operation.completed, /connection lost/);
		fixture.service.dispose();
		await completion;
		assert.deepEqual(
			fixture.client.requests.map(request => request.method),
			['dictation/model/start'],
		);
	});
	test('model import maps its source and releases before reporting completion', async () => {
		using fixture = new Fixture();
		fixture.client.startBarrier = new DeferredPromise<void>();
		fixture.client.stopBarrier = new DeferredPromise<void>();
		const progress: IDictationModelStatus[] = [];
		const operation = fixture.models.importPackage({ model: 'selected-model', sourcePath: 'C:\\models\\prepared' }, status => progress.push(status));
		await fixture.client.accepted.p;
		fixture.modelProgress({ type: 'loading' }, 'another-resource');
		fixture.modelProgress({ type: 'loading' });
		fixture.modelProgress({ type: 'ready' });
		await fixture.client.startBarrier.complete();
		await fixture.client.stopped.p;
		assert.deepEqual(progress, [{ state: DictationModelState.Loading }, { state: DictationModelState.Ready }]);
		await fixture.client.stopBarrier.complete();
		assert.equal(await operation.completed, DictationModelState.Ready);
		fixture.modelProgress({ type: 'loading' });
		assert.deepEqual(fixture.client.requests, [
			{
				method: 'dictation/model/start',
				resourceId: fixture.resourceId,
				modelId: 'selected-model',
				operation: { type: 'import', sourceDirectory: 'C:\\models\\prepared' },
			},
			{ method: 'dictation/model/stop', resourceId: fixture.resourceId },
		]);
	});

	test('model cancellation during acceptance waits and sends one backend stop', async () => {
		using fixture = new Fixture();
		fixture.client.startBarrier = new DeferredPromise<void>();
		const operation = fixture.models.prepareModel('selected-model', () => {});
		await fixture.client.accepted.p;
		const cancelled = operation.cancel();
		const repeated = operation.cancel();
		await fixture.client.startBarrier.complete();
		await Promise.all([cancelled, repeated]);
		assert.equal(await operation.completed, DictationModelState.Cancelled);
		assert.deepEqual(
			fixture.client.requests.map(request => request.method),
			['dictation/model/start', 'dictation/model/stop'],
		);
	});

	test('model failure and connection loss reject completion and remove operation listeners', async () => {
		using fixture = new Fixture();
		const baseline = fixture.client.notifications.size + fixture.client.states.size;
		const failed = fixture.models.prepareModel('selected-model', () => {});
		await fixture.client.accepted.p;
		fixture.modelProgress({ type: 'failed', error: 'Invalid model format' });
		await assert.rejects(failed.completed, /Invalid model format/);
		assert.equal(fixture.client.notifications.size + fixture.client.states.size, baseline);
		const disconnected = fixture.models.prepareModel('selected-model', () => {});
		fixture.client.disconnect();
		await assert.rejects(disconnected.completed, /connection lost/);
		assert.equal(fixture.client.notifications.size + fixture.client.states.size, baseline);
	});

	test('capture model progress reaches only the owning session', async () => {
		using fixture = new Fixture();
		const progress: unknown[] = [];
		using listener = fixture.service.onDidChangeModelStatus(status => progress.push(status));
		await fixture.service.start({ cacheDir: 'C:/models', model: 'selected-model' });
		fixture.modelProgress({ type: 'checking' }, 'other');
		fixture.modelProgress({ type: 'loading' });
		await fixture.service.cancel();
		fixture.modelProgress({ type: 'ready' });
		assert.deepEqual(progress, [{ state: LocalTranscriptionModelState.Loading }, { state: LocalTranscriptionModelState.Loading }, { state: LocalTranscriptionModelState.Idle }]);
	});
	test('production assembly rejects a missing backend registration', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(LocalTranscriptionService), /localTranscriptionBackendService/);
	});

	test('uses the shared backend and accepts only its resource transcripts', async () => {
		using fixture = new Fixture();
		const results: ILocalTranscriptionResult[] = [];
		using listener = fixture.service.onDidTranscribe(result => results.push(result));
		await fixture.service.start({ cacheDir: 'C:/models', model: 'selected-model' });
		fixture.transcript('other input', false, 'another-window');
		fixture.transcript('interim', false);
		assert.equal(await fixture.service.stop(), 'final text');
		fixture.transcript('late', true);
		assert.deepEqual(
			{ requests: fixture.client.requests, results },
			{
				requests: [
					{
						method: 'dictation/start',
						resourceId: fixture.resourceId,
						backend: { type: 'local', modelId: 'selected-model' },
						inputDevice: null,
						language: null,
						audioInput: 'pcm16',
					},
					{ method: 'dictation/stop', resourceId: fixture.resourceId },
				],
				results: [
					{ text: 'interim', isFinal: false },
					{ text: 'final text', isFinal: true },
				],
			},
		);
	});

	test('a final notification preceding stop is delivered once', async () => {
		using fixture = new Fixture();
		const results: ILocalTranscriptionResult[] = [];
		using listener = fixture.service.onDidTranscribe(result => results.push(result));
		await fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		fixture.client.beforeStop = () => {
			fixture.transcript('final text', true);
			fixture.client.emit({ method: 'dictation/ended', params: { resourceId: fixture.resourceId, error: null } });
		};
		await fixture.service.stop();
		assert.deepEqual(results, [{ text: 'final text', isFinal: true }]);
	});

	test('cancel while starting waits for acceptance and discards the final transcript', async () => {
		using fixture = new Fixture();
		fixture.client.startBarrier = new DeferredPromise<void>();
		const results: ILocalTranscriptionResult[] = [];
		using listener = fixture.service.onDidTranscribe(result => results.push(result));
		const started = fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		await fixture.client.accepted.p;
		const cancelled = fixture.service.cancel();
		assert.equal(fixture.client.requests.length, 1);
		fixture.client.beforeStop = () => fixture.transcript('discard me', true);
		await fixture.client.startBarrier.complete();
		await Promise.all([started, cancelled]);
		assert.deepEqual({ methods: fixture.client.requests.map(request => request.method), results }, { methods: ['dictation/start', 'dictation/cancel'], results: [] });
	});

	test('concurrent stop calls share one backend release', async () => {
		using fixture = new Fixture();
		fixture.client.stopBarrier = new DeferredPromise<void>();
		await fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		const first = fixture.service.stop();
		const second = fixture.service.stop();
		assert.equal(first, second);
		await fixture.client.stopped.p;
		await fixture.client.stopBarrier.complete();
		assert.deepEqual(await Promise.all([first, second]), ['final text', 'final text']);
		assert.equal(fixture.client.requests.length, 2);
	});

	test('backend preparation failure ends the input and releases its resource', async () => {
		using fixture = new Fixture();
		const completed = new DeferredPromise<{ readonly error?: string }>();
		using listener = fixture.service.onDidChangeModelStatus(result => {
			if (result.state === LocalTranscriptionModelState.Error) void completed.complete({ error: result.error });
		});
		await fixture.service.start({ cacheDir: 'C:/models', model: 'missing-model' });
		fixture.client.emit({
			method: 'dictation/ended',
			params: { resourceId: fixture.resourceId, error: 'Model preparation failed' },
		});
		assert.deepEqual(await completed.p, { error: 'Model preparation failed' });
		assert.equal(fixture.client.requests[1]!.method, 'dictation/stop');
	});

	test('disconnect ends once and ignores the old connection final response', async () => {
		using fixture = new Fixture();
		fixture.client.stopBarrier = new DeferredPromise<void>();
		const results: ILocalTranscriptionResult[] = [];
		const endings: { readonly error?: string }[] = [];
		using transcript = fixture.service.onDidTranscribe(result => results.push(result));
		using ended = fixture.service.onDidChangeModelStatus(result => {
			if (result.state === LocalTranscriptionModelState.Error) endings.push({ error: result.error });
		});
		await fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		const stop = fixture.service.stop();
		await fixture.client.stopped.p;
		fixture.client.disconnect();
		fixture.transcript('late', true);
		await fixture.client.stopBarrier.complete();
		assert.equal(await stop, '');
		assert.deepEqual({ results, endings }, { results: [], endings: [{ error: 'Dictation connection lost' }] });
	});

	test('disposal during startup releases capture after acceptance and removes listeners', async () => {
		using fixture = new Fixture();
		fixture.client.startBarrier = new DeferredPromise<void>();
		const started = fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		await fixture.client.accepted.p;
		fixture.service.dispose();
		await fixture.client.startBarrier.complete();
		await started;
		await fixture.client.cancelled.p;
		assert.deepEqual(
			{
				methods: fixture.client.requests.map(request => request.method),
				subscriptions: fixture.client.notifications.size + fixture.client.states.size,
			},
			{ methods: ['dictation/start', 'dictation/cancel'], subscriptions: 0 },
		);
		await assert.rejects(fixture.service.start({ cacheDir: 'C:/models', model: 'model' }));
	});

	for (const blocked of ['audio', 'stop'] as const) {
		test(`cancel bypasses stalled ${blocked} and retires its late response before a new capture`, async () => {
			using fixture = new Fixture();
			const results: ILocalTranscriptionResult[] = [];
			using listener = fixture.service.onDidTranscribe(result => results.push(result));
			await fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
			const oldResource = fixture.resourceId;
			const gate = new DeferredPromise<void>();
			let packet: Promise<void> | undefined;
			if (blocked === 'audio') {
				fixture.client.audioBarrier = gate;
				packet = fixture.service.pushAudio(VSBuffer.wrap(new Uint8Array([0, 1])));
			} else fixture.client.stopBarrier = gate;
			const stopping = fixture.service.stop();
			if (blocked === 'stop') await fixture.client.stopped.p;
			await fixture.service.cancel();
			assert.equal(await stopping, '');
			fixture.client.audioBarrier = fixture.client.stopBarrier = undefined;
			await fixture.service.start({ cacheDir: 'C:/models', model: 'replacement' });
			fixture.transcript('late old text', true, oldResource);
			await gate.complete();
			await packet;
			assert.deepEqual(results, []);
			assert.equal((await fixture.service.getModelStatus()).state, LocalTranscriptionModelState.Loading);
			await fixture.service.cancel();
		});
	}

	test('final delivery waits for release and the stop response is authoritative, including empty text', async () => {
		using fixture = new Fixture();
		fixture.client.stopBarrier = new DeferredPromise<void>();
		const results: ILocalTranscriptionResult[] = [];
		using listener = fixture.service.onDidTranscribe(result => results.push(result));
		await fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		fixture.transcript('early final', true);
		const stopping = fixture.service.stop();
		await fixture.client.stopped.p;
		assert.deepEqual(results, []);
		fixture.client.stopText = '';
		await fixture.client.stopBarrier.complete();
		assert.equal(await stopping, '');
		assert.deepEqual(results, [{ text: '', isFinal: true }]);
	});

	test('bounds retained PCM while an inference upload is stalled', async () => {
		using fixture = new Fixture();
		await fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		fixture.client.audioBarrier = new DeferredPromise<void>();
		const packet = fixture.service.pushAudio(VSBuffer.alloc(4 * 1024 * 1024));
		await assert.rejects(fixture.service.pushAudio(VSBuffer.alloc(2)), /backpressured/);
		await fixture.service.cancel();
		await fixture.client.audioBarrier.complete();
		await packet;
	});

	test('a rejected start permits a later session and duplicate start is rejected', async () => {
		using fixture = new Fixture();
		fixture.client.startBarrier = new DeferredPromise<void>();
		const started = fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		await fixture.client.accepted.p;
		await assert.rejects(fixture.service.start({ cacheDir: 'C:/models', model: 'other' }), /already active/);
		await fixture.client.startBarrier.error(new Error('Permission denied'));
		await assert.rejects(started, /Permission denied/);
		fixture.client.startBarrier = undefined;
		await fixture.service.start({ cacheDir: 'C:/models', model: 'model' });
		await fixture.service.stop();
	});

	test('browser service explicitly reports capture unsupported', async () => {
		using service = new NullLocalTranscriptionService();
		assert.equal(service.isSupported, false);
		await assert.rejects(service.start(), /unavailable/);
		assert.equal(await service.stop(), '');
		await service.cancel();
	});
});
