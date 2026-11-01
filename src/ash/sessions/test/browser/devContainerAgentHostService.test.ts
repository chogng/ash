import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IAgentSessionService } from '../../../platform/agentHost/common/agentService.js';
import { type SessionRuntimeResult } from '../../../platform/agentHost/common/agent.js';
import { DevContainerAgentHostService } from '../../contrib/providers/remoteAgentHost/browser/devContainerAgentHostService.js';

test('Docker service uses the admitted backend capability and retires a cancelled preparation', async () => {
	using services = new InstantiationService();
	const result = new DeferredPromise<SessionRuntimeResult>();
	let signal: AbortSignal | undefined;
	const calls: unknown[] = [];
	services.registerInstance(IAgentSessionService, { invokeRuntime(providerId, request, token) { calls.push({ providerId, request }); signal = token; return result.p; } } as IAgentSessionService);
	using containers = services.createInstance(DevContainerAgentHostService);
	using cancellation = new CancellationTokenSource();
	const pending = containers.connect('C:\\project', cancellation.token);
	const rejected = assert.rejects(pending, isCancellationError);
	cancellation.cancel();
	await rejected;
	assert.equal(signal?.aborted, true);
	await result.complete({ type: 'target', target: { type: 'provider', providerId: 'ash.dev-containers', workspace: 'C:\\project', root: '/workspace' } });
	assert.deepEqual(calls, [{ providerId: 'ash.dev-containers', request: { operation: 'prepare', workspace: 'C:\\project' } }]);
});

test('an unavailable optional Provider has no local execution fallback', async () => {
	using services = new InstantiationService();
	services.registerInstance(IAgentSessionService, {} as IAgentSessionService);
	using containers = services.createInstance(DevContainerAgentHostService);
	assert.equal(await containers.isAvailable('C:\\project', CancellationToken.None), false);
	await assert.rejects(containers.connect('C:\\project', CancellationToken.None), /Provider is unavailable/);
});

test('container controls obtain persisted sources even when the Session catalog is empty', async () => {
	using services = new InstantiationService();
	const target = { type: 'provider' as const, providerId: 'ash.dev-containers', workspace: 'C:\\project', root: '/workspace' };
	const calls: unknown[] = [];
	const backend: Pick<IAgentSessionService, 'invokeRuntime'> = {
		async invokeRuntime(providerId, request): Promise<SessionRuntimeResult> {
			calls.push({ providerId, request });
			return { type: 'targets', targets: [target, { type: 'local', root: '/other' }] };
		}
	};
	services.registerInstance(IAgentSessionService, backend as IAgentSessionService);
	using containers = services.createInstance(DevContainerAgentHostService);
	assert.deepEqual(await containers.getTargets(CancellationToken.None), [target]);
	assert.deepEqual(calls, [{ providerId: 'ash.dev-containers', request: { operation: 'list' } }]);
});

test('two drafts share preparation while a cancelled caller leaves the other running', async () => {
	using services = new InstantiationService();
	const result = new DeferredPromise<SessionRuntimeResult>();
	const target = { type: 'provider' as const, providerId: 'ash.dev-containers', workspace: '/source', root: '/workspace' };
	let calls = 0;
	let signal: AbortSignal | undefined;
	services.registerInstance(IAgentSessionService, {
		invokeRuntime(_provider, _request, cancellation) { calls++; signal = cancellation; return result.p; },
	} as IAgentSessionService);
	using containers = services.createInstance(DevContainerAgentHostService);
	using cancellation = new CancellationTokenSource();
	const first = containers.connect('/source', cancellation.token);
	const rejected = assert.rejects(first, isCancellationError);
	const second = containers.connect('/source', CancellationToken.None);
	cancellation.cancel();
	await rejected;
	assert.equal(signal?.aborted, false);
	await result.complete({ type: 'target', target });
	assert.deepEqual(await second, target);
	assert.equal(calls, 1);
});

test('cancelled preparation can be retried before an old backend reply arrives', async () => {
	using services = new InstantiationService();
	const results: DeferredPromise<SessionRuntimeResult>[] = [];
	const signals: AbortSignal[] = [];
	services.registerInstance(IAgentSessionService, {
		invokeRuntime(_provider, _request, signal) {
			const result = new DeferredPromise<SessionRuntimeResult>();
			results.push(result); signals.push(signal); return result.p;
		},
	} as IAgentSessionService);
	using containers = services.createInstance(DevContainerAgentHostService);
	using cancellation = new CancellationTokenSource();
	const first = containers.connect('/source', cancellation.token);
	const rejected = assert.rejects(first, isCancellationError);
	cancellation.cancel();
	await rejected;
	const retry = containers.connect('/source', CancellationToken.None);
	assert.deepEqual(signals.map(signal => signal.aborted), [true, false]);
	const target = { type: 'provider' as const, providerId: 'ash.dev-containers', workspace: '/source', root: '/new-root' };
	await results[1]!.complete({ type: 'target', target });
	assert.deepEqual(await retry, target);
	await results[0]!.complete({ type: 'target', target: { ...target, root: '/old-root' } });
});

test('disposing a host scope aborts its pending preparation', async () => {
	using services = new InstantiationService();
	let signal: AbortSignal | undefined;
	services.registerInstance(IAgentSessionService, {
		invokeRuntime(_provider, _request, cancellation) { signal = cancellation; return new Promise(() => { }); },
	} as IAgentSessionService);
	const containers = services.createInstance(DevContainerAgentHostService);
	const pending = containers.connect('/source', CancellationToken.None);
	const rejected = assert.rejects(pending, isCancellationError);
	containers.dispose();
	await rejected;
	assert.equal(signal?.aborted, true);
});
