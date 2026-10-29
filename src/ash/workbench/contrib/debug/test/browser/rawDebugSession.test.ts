import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import type { IDebugAdapterProcessService, IDebugAdapterProcessReadResult } from '../../../../../platform/debug/common/debugAdapterProcessService.js';
import { RawDebugSession } from '../../browser/rawDebugSession.js';

const empty: IDebugAdapterProcessReadResult = {
	messages: [],
	nextSequence: 0,
	outputGap: false,
	stderr: '',
	exited: false,
	exitCode: null,
	protocolError: null,
};

function backend(overrides: Partial<IDebugAdapterProcessService> = {}): IDebugAdapterProcessService {
	return {
		prepareSession: async () => {
			throw new Error('Not used by RawDebugSession');
		},
		reserveSession: async () => {
			throw new Error('Not used by RawDebugSession');
		},
		manageSession: async () => {
			throw new Error('Not used by RawDebugSession');
		},
		readConsole: async () => {
			throw new Error('Not used by RawDebugSession');
		},
		setExceptionBreakpoints: async () => 1,
		readWorkspaceState: async () => {
			throw new Error('Not used by RawDebugSession');
		},
		editWorkspaceState: async () => {
			throw new Error('Not used by RawDebugSession');
		},
		start: async () => 'client',
		send: async () => {},
		read: async () => empty,
		close: async () => {},
		setBreakpoints: async () => {},
		readBreakpoints: async () => ({ revision: 0, version: 0, appliedVersion: 0, bindings: [], error: null }),
		startInspection: async () => 1,
		readInspection: async () => ({ state: 'pending' }),
		initializeSession: async () => {},
		completeConfiguration: async () => {},
		startRequest: async () => 1,
		readResponse: async () => ({ state: 'pending' }),
		acceptInput: async () => {},
		getConnectionState: async () => 'ready',
		onConnectionState: Event.None,
		...overrides,
	};
}

test('RawDebugSession closes a backend handle returned after startup cancellation exactly once', async () => {
	const started = new DeferredPromise<string>();
	const closed: string[] = [];
	const session = new RawDebugSession(
		backend({
			start: () => started.p,
			close: async id => {
				closed.push(id);
			},
		}),
	);
	const starting = session.start({ program: 'adapter', arguments: [] });
	const rejected = assert.rejects(starting, { name: 'CancellationError' });
	await session.close();
	await started.complete('late-handle');
	await rejected;
	await session.close();
	assert.deepEqual(closed, ['late-handle']);
});

test('RawDebugSession discards a completion returned after close without replaying the request', async () => {
	const entered = new DeferredPromise<void>();
	const response = new DeferredPromise<{ state: 'complete'; response: unknown }>();
	let requests = 0;
	const session = new RawDebugSession(
		backend({
			startRequest: async () => {
				requests++;
				return 1;
			},
			readResponse: () => {
				void entered.complete(undefined);
				return response.p;
			},
		}),
	);
	await session.start({ program: 'adapter', arguments: [] });
	const rejected = assert.rejects(session.request('setVariable', { value: '43' }), { name: 'CancellationError' });
	await entered.p;
	await session.close();
	await response.complete({ state: 'complete', response: { body: { value: '43' } } });
	await rejected;
	assert.equal(requests, 1);
});

test('RawDebugSession detects an observation gap before forwarding any inline side effect', async () => {
	const sent: unknown[] = [];
	let input: IDebugAdapterProcessReadResult | undefined;
	const session = new RawDebugSession(
		backend({
			acceptInput: async (_id, value) => {
				input = value;
			},
			read: async () => ({
				...empty,
				outputGap: true,
				messages: [{ sequence: 2, direction: 'outgoing', message: { command: 'launch' } }],
			}),
		}),
		{
			send: async value => {
				sent.push(value);
			},
			read: async () => ({ ...empty, messages: [{ sequence: 0, message: { type: 'event', event: 'output' } }] }),
			close: async () => {},
		},
	);
	try {
		await session.start({ arguments: [], connection: { type: 'client' } });
		await assert.rejects(session.read(0, 128), /retained buffer/);
		assert.deepEqual(sent, []);
		assert.equal(input?.messages.length, 1);
	} finally {
		await session.close();
	}
});

test('RawDebugSession waits for both backend and inline close even when one close rejects', async () => {
	const released = new DeferredPromise<void>();
	const entered = new DeferredPromise<void>();
	const session = new RawDebugSession(
		backend({
			close: async () => {
				throw new Error('backend disconnected');
			},
		}),
		{
			send: async () => {},
			read: async () => empty,
			close: async () => {
				await entered.complete(undefined);
				await released.p;
			},
		},
	);
	await session.start({ arguments: [], connection: { type: 'client' } });
	let settled = false;
	const closing = session.close();
	const rejected = assert.rejects(closing, /backend disconnected/).then(() => {
		settled = true;
	});
	await entered.p;
	assert.equal(settled, false);
	assert.equal(session.close(), closing);
	await released.complete(undefined);
	await rejected;
});

test('RawDebugSession maps a refused inspection epoch to cancellation without reading or retrying', async () => {
	let starts = 0;
	let reads = 0;
	const session = new RawDebugSession(
		backend({
			startInspection: async (_id, query, revision) => {
				starts++;
				assert.equal(query.kind, 'watch');
				assert.equal(revision, 7);
				return undefined;
			},
			readInspection: async () => {
				reads++;
				return { state: 'pending' };
			},
		}),
	);
	await session.start({ program: 'adapter', arguments: [] });
	try {
		await assert.rejects(session.inspect({ kind: 'watch', expressions: ['side_effect()'], frameId: 1 }, 7), {
			name: 'CancellationError',
		});
		assert.equal(starts, 1);
		assert.equal(reads, 0);
	} finally {
		await session.close();
	}
});

test('RawDebugSession discards inspection completion returned after close', async () => {
	const entered = new DeferredPromise<void>();
	const complete = new DeferredPromise<{ state: 'complete'; value: { kind: 'variables'; variables: unknown[] } }>();
	const session = new RawDebugSession(
		backend({
			readInspection: () => {
				void entered.complete(undefined);
				return complete.p;
			},
		}),
	);
	await session.start({ program: 'adapter', arguments: [] });
	const rejected = assert.rejects(session.inspect({ kind: 'variables', variablesReference: 1 }, 0), {
		name: 'CancellationError',
	});
	await entered.p;
	await session.close();
	await complete.complete({ state: 'complete', value: { kind: 'variables', variables: [] } });
	await rejected;
});

test('RawDebugSession never forwards a queued inline request after Rust revoked the session', async () => {
	let sends = 0;
	const processes = backend({
		read: async () => ({
			...empty,
			session: {
				revision: 1,
				executionRevision: 1,
				inspectionRevision: 1,
				state: 'terminated',
				phase: 'ended',
				reason: null,
				stoppedThreadId: null,
				capabilities: {
					supportsRestart: false,
					supportsTerminate: false,
					supportsSetVariable: false,
					supportsConditionalBreakpoints: false,
					supportsHitConditionalBreakpoints: false,
					supportsLogPoints: false,
					supportsFunctionBreakpoints: false,
					supportsDataBreakpoints: false,
					supportsInstructionBreakpoints: false,
					supportsDisassembleRequest: false,
					supportsSteppingGranularity: false,
					supportsCompletionsRequest: false,
					supportsCancelRequest: false,
					completionTriggerCharacters: [],
					exceptionBreakpointFilters: [],
				},
			},
			messages: [{ sequence: 0, direction: 'outgoing', message: { seq: 1, type: 'request', command: 'launch' } }],
			nextSequence: 1,
		}),
	});
	const session = new RawDebugSession(processes, {
		read: async () => empty,
		send: async () => {
			sends++;
		},
		close: async () => {},
	});
	try {
		await session.start({ arguments: [], connection: { type: 'client' } });
		assert.equal((await session.read(0, 128)).session?.state, 'terminated');
		assert.equal(sends, 0);
	} finally {
		await session.close();
	}
});
