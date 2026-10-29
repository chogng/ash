import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { AgentVoiceSessionState, AgentVoiceTaskRequest } from '../../../../../platform/agentHost/common/agent.js';
import type { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import { createDisconnectedRendererApi } from '../../../../../workbench/browser/rendererApi.js';
import type {
	ISessionProviderScope,
	SessionProviderServices,
} from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { createSessionVoiceService } from '../../../../browser/agentHost/sessionScopedVoiceService.js';
import { parseSessionIdentity, sessionIdentity } from '../../common/sessionIdentity.js';

ensureNoDisposablesAreLeakedInTestSuite();

const state: AgentVoiceSessionState = {
	sessionId: 'same',
	threadId: 'thread',
	resourceId: 'voice-resource',
	mediaEpoch: 17,
	sequence: 29,
	state: 'connected',
	inputMode: 'pushToTalk',
	muted: false,
	listening: true,
	inputSequence: 8,
	usageMilliseconds: 55,
};
const task: AgentVoiceTaskRequest = {
	sessionId: 'same',
	threadId: 'thread',
	resourceId: state.resourceId,
	mediaEpoch: state.mediaEpoch,
	delegationId: 'delegation',
	commandId: 'command',
	transcript: 'Do this',
};

function fixture() {
	const lifetime = new DisposableStore();
	const changed = lifetime.add(new Emitter<void>());
	const tasks = lifetime.add(new Emitter<AgentVoiceTaskRequest>());
	const calls: unknown[] = [];
	let retired = false;
	let active = { ...state };
	const backend: IAgentVoiceService = {
		isAvailable: true,
		get state() {
			return active;
		},
		onDidChange: changed.event,
		onDidRequestTask: tasks.event,
		async getOptions() {
			calls.push('options');
			return [{ connectionId: 'model-connection', name: 'Remote', defaultModel: 'model', models: [] }];
		},
		async start(source, selection, signal) {
			calls.push({ source, selection, signal });
			return { ...active, ...source };
		},
		async stop() {
			calls.push('stop');
		},
		async interrupt() {
			calls.push('interrupt');
		},
		async setMuted(value) {
			calls.push({ muted: value });
		},
		async setInputMode(value) {
			calls.push({ inputMode: value });
		},
		async pttDown(id) {
			calls.push({ down: id });
		},
		async pttUp(id) {
			calls.push({ up: id });
		},
		async rejectTask(request) {
			calls.push(request);
		},
	};
	const host = { ...createDisconnectedRendererApi(), agentVoice: backend };
	const scope: ISessionProviderScope = {
		providerId: 'remote',
		services: { host } as SessionProviderServices,
		thread: host.thread,
		identity: value => sessionIdentity('remote', value, 'primary'),
		backendIdentity: value => {
			const parsed = parseSessionIdentity(value, 'primary');
			if (parsed.providerId !== 'remote') throw canceled();
			return parsed.backendSessionId;
		},
		assertCurrent: () => {
			if (retired) throw canceled();
		},
	};
	return {
		lifetime,
		scope,
		backend,
		calls,
		changed,
		tasks,
		retire: () => {
			retired = true;
		},
		replaceState: (value: AgentVoiceSessionState) => {
			active = value;
		},
		[Symbol.dispose]: () => lifetime.dispose(),
	};
}

test('retained remote voice unwraps dispatch coordinates and preserves backend media/task identities', async () => {
	using context = fixture();
	const voice = createSessionVoiceService(context.scope)!;
	const source = { sessionId: context.scope.identity('same'), threadId: context.scope.identity('thread') };
	const selection = { connectionId: 'model-connection', modelId: 'model', voice: 'voice' };
	const signal = new AbortController().signal;
	const result = await voice.start(source, selection, signal);
	assert.deepEqual(context.calls, [{ source: { sessionId: 'same', threadId: 'thread' }, selection, signal }]);
	assert.deepEqual(result, { ...state, ...source });
	assert.deepEqual(voice.state, result);
	context.replaceState({ ...state, sequence: 30, mediaEpoch: 18 });
	assert.equal(voice.state?.sequence, 30, 'state stays borrowed from the original backend');
	assert.equal(voice.state?.mediaEpoch, 18);
	const received: AgentVoiceTaskRequest[] = [];
	using listener = voice.onDidRequestTask(value => received.push(value));
	context.tasks.fire(task);
	assert.deepEqual(received, [{ ...task, ...source }]);
	await voice.rejectTask(received[0]!);
	assert.deepEqual(context.calls[1], task);
});

test('retiring voice scope hides availability/state/events and rejects every command without fallback', async () => {
	using context = fixture();
	const voice = createSessionVoiceService(context.scope)!;
	let changes = 0;
	let tasks = 0;
	using changed = voice.onDidChange(() => changes++);
	using requested = voice.onDidRequestTask(() => tasks++);
	context.changed.fire();
	context.tasks.fire(task);
	assert.equal(changes, 1);
	assert.equal(tasks, 1);
	context.retire();
	assert.equal(voice.isAvailable, false);
	assert.equal(voice.state, undefined);
	context.changed.fire();
	context.tasks.fire(task);
	assert.equal(changes, 1);
	assert.equal(tasks, 1);
	const source = { sessionId: context.scope.identity('same'), threadId: context.scope.identity('thread') };
	for (const operation of [
		() => voice.getOptions(),
		() => voice.start(source, { connectionId: 'connection' }),
		() => voice.stop(),
		() => voice.interrupt(),
		() => voice.setMuted(true),
		() => voice.setInputMode('openMic'),
		() => voice.pttDown('hold'),
		() => voice.pttUp('hold'),
		() => voice.rejectTask({ ...task, ...source }),
	]) {
		await assert.rejects(operation(), isCancellationError);
	}
	assert.deepEqual(context.calls, []);
});

test('a retired voice scope rejects late asynchronous results while retaining connection metadata', async () => {
	using context = fixture();
	const response = new DeferredPromise<AgentVoiceSessionState>();
	context.backend.start = async () => response.p;
	const voice = createSessionVoiceService(context.scope)!;
	const source = { sessionId: context.scope.identity('same'), threadId: context.scope.identity('thread') };
	const pending = voice.start(source, { connectionId: 'connection' });
	context.retire();
	await response.complete(state);
	await assert.rejects(pending, isCancellationError);
});

test('voice absence and foreign frontend Session identities never inherit the primary voice owner', async () => {
	using context = fixture();
	const voice = createSessionVoiceService(context.scope)!;
	await assert.rejects(
		voice.start({ sessionId: 'same', threadId: 'thread' }, { connectionId: 'connection' }),
		isCancellationError,
	);
	assert.deepEqual(context.calls, []);
	const missing = {
		...context.scope,
		services: { host: createDisconnectedRendererApi() } as SessionProviderServices,
	};
	assert.equal(createSessionVoiceService(missing), undefined);
});
