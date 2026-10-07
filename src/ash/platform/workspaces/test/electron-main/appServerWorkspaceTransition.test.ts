import assert from 'node:assert/strict';
import type { WebContents } from 'electron/main';
import { suite, test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { AppServerConnectionRelay } from '../../../app-server/electron-main/appServerConnectionRelay.js';
import { AppServerDaemonLauncher } from '../../../app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { RemoteAppServerProcessLauncher } from '../../../remote/electron-main/remoteAppServerProcessLauncher.js';
import { createSshRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import { createAppServerWorkspaceTransitionAdapter, reconnectAppServerWorkspace } from '../../electron-main/appServerWorkspaceTransition.js';
import { RendererWorkspaceHost } from '../../electron-main/rendererWorkspaceHost.js';

suite('App Server workspace connection replacement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const kind of ['local', 'remote'] as const) {
		for (const failedStage of ['none', 'start', 'folders', 'rollback'] as const) {
			test(`${kind} replacement ${failedStage === 'none' ? 'commits the new scope' : `restores the previous scope after ${failedStage} failure`}`, async () => {
				using carrier = new AppServerDaemonLauncher({
					executable: '/daemon', args: ['connect'],
					environment: { ASH_HOME: '/profile', ASH_WORKSPACE_ROOT: '/previous', ASH_DIR_GRANT_SOURCE: 'host' },
				});
				const previousEnvironment = carrier.environment;
				const launcher = kind === 'local' ? carrier : new RemoteAppServerProcessLauncher({
					workspace: createSshRemoteWorkspaceUri('server', '/previous'),
					sshExecutable: 'ssh', remoteExecutable: '/bin/ash-app-server', localEnvironment: {}, carrier,
				});
				const events: unknown[] = [];
				let starts = 0;
				const failure = new Error('Replacement failed');
				const rollbackFailure = new Error('Rollback failed');
				const relay = {
					options: { enabled: true, processLauncher: launcher }, state: 'ready', onStateChange: Event.None,
					stop: async () => { events.push('stop'); },
					start: async () => {
						starts++;
						events.push(['start', kind === 'local' ? carrier.environment.ASH_WORKSPACE_ROOT : (launcher as RemoteAppServerProcessLauncher).workspaceRoot]);
						if (starts === 1 && (failedStage === 'start' || failedStage === 'rollback')) { throw failure; }
						if (starts === 2 && failedStage === 'rollback') { throw rollbackFailure; }
					},
				} as unknown as AppServerConnectionRelay;
				using workspaceHost = new RendererWorkspaceHost({
					send: (_channel: string, request: { nonce: string; operation: string; params: unknown; }) => {
						events.push([request.operation, request.params]);
						queueMicrotask(() => workspaceHost.routes()[0]!.invoke({
							nonce: request.nonce,
							...(request.operation === 'setFolders' && starts === 1 && failedStage === 'folders' ? { error: failure.message } : {}),
						}));
					},
				} as unknown as WebContents);
				const adapter = createAppServerWorkspaceTransitionAdapter(relay, workspaceHost);
				const operation = adapter.switchWorkspace({
					transitionId: 1, previous: { id: 'previous', uri: URI.file('/previous') },
					workspace: { id: 'next', uri: URI.file('/next') }, root: '/next', grant: { type: 'config' },
				});
				if (failedStage === 'none') {
					await operation;
					assert.deepEqual(events, [
						['persistDirectoryGrant', { path: '/next', grant: { type: 'config' } }], 'stop', ['start', '/next'],
						['setFolders', { folders: [{ id: 'next', path: '/next', grant: { type: 'config' } }] }],
					]);
				} else {
					await assert.rejects(operation, error => failedStage === 'rollback'
						? error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === rollbackFailure
						: error instanceof Error && error.message === failure.message);
					assert.equal(kind === 'local' ? carrier.environment.ASH_WORKSPACE_ROOT : (launcher as RemoteAppServerProcessLauncher).workspaceRoot, '/previous');
					if (kind === 'local') { assert.deepEqual(carrier.environment, previousEnvironment); }
					if (failedStage !== 'rollback') {
						assert.deepEqual(events.slice(-2), [
							['start', '/previous'], ['setFolders', { folders: [{ id: 'previous', path: '/previous', grant: { type: 'config' } }] }],
						]);
					}
				}
			});
		}
	}

	test('an empty workspace clears the local scope and publishes no folders', async () => {
		using launcher = new AppServerDaemonLauncher({ executable: '/daemon', args: [], environment: { ASH_HOME: '/profile', ASH_WORKSPACE_ROOT: '/previous', ASH_DIR_GRANT_SOURCE: 'host' } });
		let folders: unknown;
		using host = new RendererWorkspaceHost({
			send: (_channel: string, request: { nonce: string; params: unknown; }) => {
				folders = request.params;
				queueMicrotask(() => host.routes()[0]!.invoke({ nonce: request.nonce }));
			}
		} as unknown as WebContents);
		const relay = { options: { enabled: true, processLauncher: launcher }, stop: async () => { }, start: async () => { } } as unknown as AppServerConnectionRelay;
		await reconnectAppServerWorkspace(relay, host, undefined, { type: 'config' }, 'empty', 'previous');
		assert.deepEqual({ environment: launcher.environment, folders }, { environment: { ASH_HOME: '/profile' }, folders: { folders: [] } });
	});
});
