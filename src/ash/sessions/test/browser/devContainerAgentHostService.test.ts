import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IAgentSessionService } from '../../../platform/agentHost/common/agentService.js';
import { type SessionRuntimeResult } from '../../../platform/agentHost/common/agent.js';
import { DevContainerAgentHostService } from '../../browser/devContainerAgentHostService.js';

test('Docker service uses the admitted backend capability and retires a cancelled preparation', async () => {
	using services = new InstantiationService();
	const result = new DeferredPromise<SessionRuntimeResult>();
	let signal: AbortSignal | undefined;
	const calls: unknown[] = [];
	services.registerInstance(IAgentSessionService, {
		invokeRuntime(providerId, request, token) {
			calls.push({ providerId, request });
			signal = token;
			return result.p;
		},
	} as IAgentSessionService);
	const containers = services.createInstance(DevContainerAgentHostService);
	using cancellation = new CancellationTokenSource();
	const pending = containers.connect('C:\\project', cancellation.token);
	cancellation.cancel();
	assert.equal(signal?.aborted, true);
	await result.complete({
		type: 'target',
		target: { type: 'provider', providerId: 'ash.dev-containers', workspace: 'C:\\project', root: '/workspace' },
	});
	await assert.rejects(pending, isCancellationError);
	assert.deepEqual(calls, [
		{ providerId: 'ash.dev-containers', request: { operation: 'prepare', workspace: 'C:\\project' } },
	]);
});

test('an unavailable optional Provider has no local execution fallback', async () => {
	using services = new InstantiationService();
	services.registerInstance(IAgentSessionService, {} as IAgentSessionService);
	const containers = services.createInstance(DevContainerAgentHostService);
	await assert.rejects(containers.connect('C:\\project', CancellationToken.None), /Provider is unavailable/);
});

test('container controls obtain persisted sources even when the Session catalog is empty', async () => {
	using services = new InstantiationService();
	const target = {
		type: 'provider' as const,
		providerId: 'ash.dev-containers',
		workspace: 'C:\\project',
		root: '/workspace',
	};
	const calls: unknown[] = [];
	const backend: Pick<IAgentSessionService, 'invokeRuntime'> = {
		async invokeRuntime(providerId, request): Promise<SessionRuntimeResult> {
			calls.push({ providerId, request });
			return { type: 'targets', targets: [target, { type: 'local', root: '/other' }] };
		},
	};
	services.registerInstance(IAgentSessionService, backend as IAgentSessionService);
	const containers = services.createInstance(DevContainerAgentHostService);
	assert.deepEqual(await containers.getTargets(CancellationToken.None), [target]);
	assert.deepEqual(calls, [{ providerId: 'ash.dev-containers', request: { operation: 'list' } }]);
});
