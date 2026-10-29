import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import type { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import type {
	AgentVoiceSessionState,
	AgentVoiceSource,
	AgentVoiceTaskRequest,
} from '../../../../../platform/agentHost/common/agent.js';
import { VoiceSessionController } from '../../browser/voiceClient/voiceSessionController.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ChatWidgetService } from '../../browser/widget/chatWidgetService.js';
import type { IChatWidget } from '../../browser/chat.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('Chat widget targeting belongs to one window and releases each registered focus listener', () => {
	const dom = new JSDOM('<!doctype html><body><input></body>');
	using close = toDisposable(() => dom.window.close());
	using firstWindow = new ChatWidgetService();
	using secondWindow = new ChatWidgetService();
	const input = dom.window.document.querySelector('input')!;
	const widget: IChatWidget = {
		sessionId: undefined,
		threadId: undefined,
		onDidChangeVisibility: Event.None,
		domNode: input,
		visible: true,
		inputEditor: undefined,
		isTranscriptProgressActive: false,
		onDidHide: Event.None,
		onDidChangeViewModel: Event.None,
		startVoiceConversation: async () => {
			throw new Error('Unexpected voice mode');
		},
	};
	using registration = firstWindow.register(widget);
	input.focus();
	assert.equal(firstWindow.lastFocusedWidget, widget);
	assert.equal(secondWindow.lastFocusedWidget, undefined);
	registration.dispose();
	input.blur();
	input.focus();
	assert.equal(firstWindow.lastFocusedWidget, undefined);
	assert.deepEqual(firstWindow.getAllWidgets(), []);
});

class Voice extends Disposable implements IAgentVoiceService {
	readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;
	readonly tasks = this._register(new Emitter<AgentVoiceTaskRequest>());
	readonly onDidRequestTask = this.tasks.event;
	isAvailable = true;
	state: AgentVoiceSessionState | undefined;
	stops = 0;
	starts = 0;
	rejected = 0;
	options: Promise<readonly { connectionId: string; name: string; defaultModel: string; models: readonly [] }[]> =
		Promise.resolve([{ connectionId: 'voice', name: 'Voice', defaultModel: 'speech', models: [] }]);
	getOptions() {
		return this.options;
	}
	async start(source: AgentVoiceSource): Promise<AgentVoiceSessionState> {
		this.starts++;
		this.state = {
			...source,
			resourceId: 'media',
			mediaEpoch: this.starts,
			sequence: 1,
			state: 'connected',
			inputMode: 'openMic' as const,
			muted: false,
			listening: true,
			inputSequence: 0,
			usageMilliseconds: 0,
		};
		this.changes.fire();
		return this.state;
	}
	async stop(): Promise<void> {
		this.stops++;
		if (this.state) this.state = { ...this.state, state: 'ended' };
		this.changes.fire();
	}
	async interrupt(): Promise<void> {
		if (this.state) this.state = { ...this.state, mediaEpoch: this.state.mediaEpoch + 1 };
		this.changes.fire();
	}
	private hold: string | undefined;
	async setMuted(muted: boolean): Promise<void> {
		this.hold = undefined;
		if (this.state) this.state = { ...this.state, muted, listening: !muted && this.state.inputMode === 'openMic' };
		this.changes.fire();
	}
	async setInputMode(inputMode: AgentVoiceSessionState['inputMode']): Promise<void> {
		this.hold = undefined;
		if (this.state)
			this.state = { ...this.state, inputMode, listening: !this.state.muted && inputMode === 'openMic' };
		this.changes.fire();
	}
	async pttDown(id: string): Promise<void> {
		if (this.state?.inputMode === 'pushToTalk' && !this.state.muted) {
			this.hold = id;
			this.state = { ...this.state, listening: true };
			this.changes.fire();
		}
	}
	async pttUp(id: string): Promise<void> {
		if (this.state && this.hold === id) {
			this.hold = undefined;
			this.state = { ...this.state, listening: false };
			this.changes.fire();
		}
	}
	async rejectTask(): Promise<void> {
		this.rejected++;
	}
}
const source = { sessionId: 'session', threadId: 'thread' };
const gesture = { navigator: { userActivation: { isActive: true } } } as Window & typeof globalThis;
function request(epoch = 1): AgentVoiceTaskRequest {
	return {
		...source,
		resourceId: 'media',
		mediaEpoch: epoch,
		delegationId: 'proposal',
		commandId: 'command',
		transcript: 'run tests',
	};
}

test('Voice controls affect only their original Chat owner and an old release cannot end a newer hold', async () => {
	using voice = new Voice();
	using owner = new VoiceSessionController(
		async () => {},
		error => {
			throw error;
		},
		undefined,
		voice,
	);
	owner.setSource(source);
	await owner.connect(gesture);
	using other = new VoiceSessionController(
		async () => {},
		error => {
			throw error;
		},
		undefined,
		voice,
	);
	other.setSource({ ...source, threadId: 'other' });
	await owner.setInputMode('pushToTalk');
	assert.equal(owner.isListening, false);
	await owner.pttDown('first');
	await owner.pttDown('second');
	await owner.pttUp('first');
	assert.equal(owner.isListening, true);
	await other.setMuted(true);
	assert.equal(owner.isMuted, false);
	await owner.pttUp('second');
	assert.equal(owner.isListening, false);
	await owner.setMuted(true);
	await owner.pttDown('muted');
	assert.equal(owner.isListening, false);
	await owner.setMuted(false);
	assert.equal(owner.isListening, false);
});

test('Voice client requires a user action and never starts a media session from script alone', async () => {
	using voice = new Voice();
	using client = new VoiceSessionController(
		async () => {},
		error => {
			throw error;
		},
		undefined,
		voice,
	);
	client.setSource(source);
	await assert.rejects(client.connect(undefined as unknown as Window & typeof globalThis), /user action/u);
	assert.equal(voice.starts, 0);
	await client.connect(gesture);
	assert.equal(client.isConnected, true);
});

test('Voice client rejects an options result after the original Chat source changes', async () => {
	using voice = new Voice();
	const options = new DeferredPromise<Awaited<ReturnType<Voice['getOptions']>>>();
	voice.options = options.p;
	using client = new VoiceSessionController(
		async () => {},
		error => {
			throw error;
		},
		undefined,
		voice,
	);
	client.setSource(source);
	const pending = client.connect(gesture);
	const rejected = assert.rejects(pending, isCancellationError);
	client.setSource({ ...source, threadId: 'other' });
	await options.complete([{ connectionId: 'voice', name: 'Voice', defaultModel: 'speech', models: [] }]);
	await rejected;
	assert.equal(voice.starts, 0);
	assert.equal(client.isActive, false);
});

test('Voice client materializes the original Untitled source once without submitting an empty task', async () => {
	using voice = new Voice();
	let prepared = 0;
	let sent = 0;
	using client = new VoiceSessionController(
		async () => {
			sent++;
		},
		error => {
			throw error;
		},
		async () => {
			prepared++;
			client.setSource(source);
			return source;
		},
		voice,
	);
	assert.equal(client.isAvailable, true);
	await client.connect(gesture);
	assert.equal(prepared, 1);
	assert.equal(sent, 0);
	assert.deepEqual({ sessionId: voice.state?.sessionId, threadId: voice.state?.threadId }, source);
});

test('Voice client binds delegation once per original source and epoch and cancels pending dispatch on a source switch', async () => {
	using voice = new Voice();
	const sent: string[] = [];
	const errors: unknown[] = [];
	using client = new VoiceSessionController(
		async task => {
			sent.push(task.commandId);
		},
		error => errors.push(error),
		undefined,
		voice,
	);
	client.setSource(source);
	await client.connect(gesture);
	voice.tasks.fire({ ...request(), threadId: 'other' });
	voice.tasks.fire(request());
	voice.tasks.fire(request());
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(sent, ['command']);
	await client.stopSpeaking();
	voice.tasks.fire(request());
	assert.deepEqual(sent, ['command']);
	voice.tasks.fire(request(2));
	client.setSource({ ...source, threadId: 'other' });
	for (let i = 0; i < 8; i++) await Promise.resolve();
	assert.deepEqual(sent, ['command']);
	assert.deepEqual(errors, []);
	assert.equal(voice.stops, 1);
});

test('Voice client releases an ended controller so the same Chat can start a fresh media session', async () => {
	using voice = new Voice();
	using client = new VoiceSessionController(
		async () => {},
		error => {
			throw error;
		},
		undefined,
		voice,
	);
	client.setSource(source);
	await client.connect(gesture);
	await voice.stop();
	assert.equal(client.isActive, false);
	await client.connect(gesture);
	assert.equal(voice.starts, 2);
	assert.equal(client.isConnected, true);
});

test('Voice client reports a rejected task through the original media owner and coalesces stop', async () => {
	using voice = new Voice();
	const errors: unknown[] = [];
	const failure = new Error('original Chat rejected');
	using client = new VoiceSessionController(
		async () => {
			throw failure;
		},
		error => errors.push(error),
		undefined,
		voice,
	);
	client.setSource(source);
	await client.connect(gesture);
	voice.tasks.fire(request());
	for (let i = 0; i < 8; i++) await Promise.resolve();
	assert.equal(voice.rejected, 1);
	assert.deepEqual(errors, [failure]);
	await Promise.all([client.disconnect(), client.disconnect()]);
	assert.equal(voice.stops, 1);
});

test('Voice client does not materialize a different Untitled draft after a delayed provider lookup', async () => {
	using voice = new Voice();
	const options = new DeferredPromise<Awaited<ReturnType<Voice['getOptions']>>>();
	voice.options = options.p;
	let prepared = 0;
	using client = new VoiceSessionController(
		async () => {},
		error => {
			throw error;
		},
		async () => {
			prepared++;
			return source;
		},
		voice,
	);
	client.setSource(undefined, 'first-draft');
	const pending = client.connect(gesture);
	const rejected = assert.rejects(pending, isCancellationError);
	client.setSource(undefined, 'replacement-draft');
	await options.complete([{ connectionId: 'voice', name: 'Voice', defaultModel: 'speech', models: [] }]);
	await rejected;
	assert.equal(prepared, 0);
	assert.equal(voice.starts, 0);
});

test('Voice client reports a running media failure once and permits a fresh conversation', async () => {
	using voice = new Voice();
	const errors: unknown[] = [];
	using client = new VoiceSessionController(
		async () => {},
		error => errors.push(error),
		undefined,
		voice,
	);
	client.setSource(source);
	await client.connect(gesture);
	voice.state = { ...voice.state!, state: 'failed', error: 'Original media connection failed' };
	voice.changes.fire();
	voice.changes.fire();
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as Error).message, 'Original media connection failed');
	assert.equal(client.isActive, false);
	await client.connect(gesture);
	assert.equal(voice.starts, 2);
});

for (const sameThread of [false, true]) {
	test(`Voice lookup cancellation never stops another Widget's owned media${sameThread ? ' in the same Thread' : ''}`, async () => {
		using voice = new Voice();
		const options = new DeferredPromise<Awaited<ReturnType<Voice['getOptions']>>>();
		voice.options = options.p;
		using waiting = new VoiceSessionController(
			async () => {},
			error => {
				throw error;
			},
			undefined,
			voice,
		);
		waiting.setSource(source);
		const pending = waiting.connect(gesture);
		const rejected = assert.rejects(pending, isCancellationError);
		voice.options = Promise.resolve([{ connectionId: 'voice', name: 'Voice', defaultModel: 'speech', models: [] }]);
		using owning = new VoiceSessionController(
			async () => {},
			error => {
				throw error;
			},
			undefined,
			voice,
		);
		owning.setSource(sameThread ? source : { ...source, threadId: 'other' });
		await owning.connect(gesture);
		await waiting.disconnect();
		assert.equal(voice.stops, 0);
		assert.equal(owning.isConnected, true);
		await options.complete([{ connectionId: 'voice', name: 'Voice', defaultModel: 'speech', models: [] }]);
		await rejected;
		assert.equal(voice.stops, 0);
		assert.equal(owning.isConnected, true);
	});
}

test('Voice tasks arriving before the start receipt are delivered only for its actual resource', async () => {
	class EarlyVoice extends Voice {
		override async start(target: AgentVoiceSource): Promise<AgentVoiceSessionState> {
			const status = await super.start(target);
			this.tasks.fire({ ...request(), resourceId: 'foreign-resource' });
			this.tasks.fire(request());
			return status;
		}
	}
	using voice = new EarlyVoice();
	const sent: string[] = [];
	using client = new VoiceSessionController(
		async task => {
			sent.push(task.commandId);
		},
		error => {
			throw error;
		},
		undefined,
		voice,
	);
	client.setSource(source);
	await client.connect(gesture);
	await Promise.resolve();
	assert.deepEqual(sent, ['command']);
});

test('a retired Voice lookup cannot clear a replacement connection receipt during disconnect', async () => {
	const receipt = new DeferredPromise<AgentVoiceSessionState>();
	const entered = new DeferredPromise<void>();
	class PendingVoice extends Voice {
		override async start(): Promise<AgentVoiceSessionState> {
			this.starts++;
			void entered.complete();
			return receipt.p;
		}
	}
	using voice = new PendingVoice();
	const options = new DeferredPromise<Awaited<ReturnType<Voice['getOptions']>>>();
	voice.options = options.p;
	using owner = new VoiceSessionController(
		async () => {},
		error => {
			throw error;
		},
		undefined,
		voice,
	);
	owner.setSource(source);
	const first = owner.connect(gesture);
	const rejectedFirst = assert.rejects(first, isCancellationError);
	await owner.disconnect();
	voice.options = Promise.resolve([{ connectionId: 'voice', name: 'Voice', defaultModel: 'speech', models: [] }]);
	const second = owner.connect(gesture);
	const rejectedSecond = assert.rejects(second, isCancellationError);
	await entered.p;
	await options.complete([]);
	await rejectedFirst;
	let disconnected = false;
	const stopping = owner.disconnect().then(() => {
		disconnected = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(disconnected, false, 'disconnect must wait for its own start receipt');
	await receipt.complete({
		...source,
		resourceId: 'replacement',
		mediaEpoch: 1,
		sequence: 1,
		state: 'ended',
		inputMode: 'openMic',
		muted: false,
		listening: false,
		inputSequence: 0,
		usageMilliseconds: 0,
	});
	await Promise.all([stopping, rejectedSecond]);
	assert.equal(owner.isActive, false);
});
