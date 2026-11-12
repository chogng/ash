import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { setup, suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import type { ISandboxGlobals } from '../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import { registerAction2 } from '../../../platform/actions/common/actions.js';
import { buildOpenSessionLinkUri, type OpenSessionLink } from '../../../platform/agentHost/common/openSessionLink.js';
import { IRemoteAgentHostService, type IRemoteAgentHostConnectionInfo } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../platform/native/common/nativeHost.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { createSshRemoteWorkspaceUri } from '../../../platform/remote/common/remote.js';
import type { RemoteAgentConnection } from '../../../platform/remote/common/remoteAgentApi.js';
import { OPEN_IDE_SESSION_CHANNEL, validateOpenIdeSessionRequest } from '../../../platform/window/common/window.js';
import { INativeHostService } from '../../../workbench/common/services.js';
import { IChatSessionNavigationService, type IPreparedChatConversation } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { IAppServerRemoteAgentService } from '../../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, sshAgentHostProviderId } from '../../common/agentHostSessionsProvider.js';
import { ISessionsService, type SessionsViewSelection } from '../../services/sessions/browser/sessionsService.js';
import type { ISession, ISessionWorkspace } from '../../services/sessions/common/session.js';
import { sessionProviderAuthority } from '../../services/sessions/common/sessionIdentity.js';

const command = 'agents.openSessionInAsh';
const sshHost = { kind: 'ssh', authority: 'ssh+first-host', host: 'first-host', generation: 1 } as const;
const link: OpenSessionLink = { connectionAuthority: 'local', sessionId: 'backend-session', threadId: 'backend-thread' };
const workspace: ISessionWorkspace = { authorityId: sshHost.authority, root: '/project/worktree' };

function selection(directory: ISessionWorkspace | null = workspace): SessionsViewSelection {
	const session: ISession = {
		sessionId: 'window-session', kind: 'code', title: 'Conversation', status: 'active', nextApprovalMode: 'auto',
		workspace: { authorityId: 'ssh+first-host', root: '/project' },
		chats: [{ threadId: 'window-thread', workspace: directory, origin: { type: 'root' }, status: 'active' }],
	};
	return { kind: 'session', active: { session, threadId: 'window-thread' } };
}

suite('Open IDE connection routing', () => {
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const requests: unknown[] = [];
	let registration: { dispose(): void; };
	suiteSetup(async () => {
		const globals: ISandboxGlobals = {
			ipcRenderer: {
				invoke: async (channel, value) => {
					assert.equal(channel, OPEN_IDE_SESSION_CHANNEL);
					validateOpenIdeSessionRequest(value);
					requests.push(value);
				},
				send: () => assert.fail('Unexpected IPC send'),
				on: () => assert.fail('Unexpected IPC subscription'),
			},
			ipcMessagePort: { acquire: () => assert.fail('Unexpected connection acquisition') },
			process: { platform: process.platform, arch: process.arch, isBuilt: false },
			webUtils: { getPathForFile: () => '' },
		};
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		const { OpenSessionInAshAction } = await import('../../electron-browser/actions/ashActions.js');
		registration = registerAction2(OpenSessionInAshAction);
	});
	suiteTeardown(() => {
		registration?.dispose();
		if (previousGlobals) Object.defineProperty(globalThis, 'ash', previousGlobals);
		else Reflect.deleteProperty(globalThis, 'ash');
	});
	setup(() => { requests.length = 0; });

	function fixture(services: InstantiationService, ambient: RemoteAgentConnection | undefined) {
		const state = {
			selection: selection() as SessionsViewSelection | undefined, revision: 0,
			directory: { type: 'ssh', host: sshHost.host, root: workspace.root } as IPreparedChatConversation['directory'],
		};
		const notifications: unknown[] = [];
		const windows: unknown[] = [];
		const hosts: IRemoteAgentHostConnectionInfo[] = [];
		let prepare = async (_sessionId: string, _threadId: string): Promise<OpenSessionLink> => link;
		services.registerInstance(ISessionsService, {
			get activeSelection() { return state.selection; },
			get navigationRevision() { return state.revision; },
		} as ISessionsService);
		services.registerInstance(INativeHostService, { openWindow: async options => { windows.push(options); } } as INativeHostApi);
		services.registerInstance(INotificationService, { info: (message: unknown) => { notifications.push(message); } } as INotificationService);
		services.registerInstance(IRemoteAgentHostService, { connections: hosts } as unknown as IRemoteAgentHostService);
		services.registerInstance(IAppServerRemoteAgentService, { connection: ambient } as IAppServerRemoteAgentService);
		services.registerInstance(IChatSessionNavigationService, {
			prepareConversation: async (sessionId, threadId) => ({ link: await prepare(sessionId, threadId), directory: state.directory }),
		} as IChatSessionNavigationService);
		return { state, notifications, windows, hosts, prepareWith: (operation: typeof prepare) => { prepare = operation; } };
	}

	test('returns the first ambient SSH conversation to its host and selected Thread directory', async () => {
		using services = new InstantiationService();
		const f = fixture(services, sshHost);
		f.state.selection = selection(null);
		f.prepareWith(async (sessionId, threadId) => {
			assert.deepEqual([sessionId, threadId], ['window-session', 'window-thread']);
			return link;
		});
		using commands = new CommandService(services);
		await commands.executeCommand(command);
		assert.deepEqual(requests, [{ folder: createSshRemoteWorkspaceUri(sshHost.host, workspace.root).toString(), conversation: buildOpenSessionLinkUri(link.sessionId, link.threadId, 'local').toString() }]);
		assert.deepEqual(f.notifications, []);
		assert.deepEqual(f.windows, []);
	});

	for (const ambient of [undefined, { kind: 'local', generation: 1 } as const, { ...sshHost, authority: 'ssh+second-host', host: 'second-host' }, { kind: 'remote', authority: sshHost.authority, generation: 1 } as const]) {
		test(`does not infer ambient SSH ownership from the directory with ${ambient?.kind ?? 'unknown'} host ${ambient && 'authority' in ambient ? ambient.authority : ''}`, async () => {
			using services = new InstantiationService();
			const f = fixture(services, ambient);
			using commands = new CommandService(services);
			await commands.executeCommand(command);
			assert.deepEqual(requests, ambient?.kind === 'local'
				? [{ folder: undefined, conversation: buildOpenSessionLinkUri(link.sessionId, link.threadId, 'local').toString() }] : []);
			assert.deepEqual(f.windows, []);
			assert.equal(f.notifications.length, 1);
		});
	}

	for (const directory of [null, { authorityId: 'local', root: '/local-project' }]) {
		test(`does not send an SSH ambient conversation to the local fallback with ${directory ? 'a local' : 'no'} directory`, async () => {
			using services = new InstantiationService();
			const f = fixture(services, sshHost);
			f.state.selection = selection(directory);
			f.state.directory = directory ? { type: 'local', root: directory.root } : null;
			using commands = new CommandService(services);
			await commands.executeCommand(command);
			assert.deepEqual(requests, []);
			assert.deepEqual(f.windows, []);
			assert.equal(f.notifications.length, 1);
		});
	}

	for (const host of ['first-host', 'second-host']) {
		test(`keeps an explicit SSH provider on its owning ${host}`, async () => {
			using services = new InstantiationService();
			const f = fixture(services, sshHost);
			const connection = { host, workspace: '/project', name: host };
			f.hosts.push({ id: host, connection, state: 'ready', host: undefined });
			const authority = sessionProviderAuthority(sshAgentHostProviderId(connection), LOCAL_AGENT_HOST_PROVIDER_ID);
			f.prepareWith(async () => ({ ...link, connectionAuthority: authority }));
			using commands = new CommandService(services);
			await commands.executeCommand(command);
			const matches = host === sshHost.host;
			assert.deepEqual(requests, [{ folder: matches ? createSshRemoteWorkspaceUri(host, workspace.root).toString() : undefined, conversation: buildOpenSessionLinkUri(link.sessionId, link.threadId, matches ? 'local' : authority).toString() }]);
			assert.equal(f.notifications.length, matches ? 0 : 1);
		});
	}

	test('preserves local conversations and their directories', async () => {
		using services = new InstantiationService();
		const f = fixture(services, { kind: 'local', generation: 1 });
		f.state.selection = selection({ authorityId: 'local', root: '/local-project' });
		f.state.directory = { type: 'local', root: '/local-project' };
		using commands = new CommandService(services);
		await commands.executeCommand(command);
		assert.deepEqual(requests, [{ folder: 'file:///local-project', conversation: buildOpenSessionLinkUri(link.sessionId, link.threadId, 'local').toString() }]);
		assert.deepEqual(f.notifications, []);
	});

	test('opens an SSH draft directory without preparing or rewriting a conversation', async () => {
		using services = new InstantiationService();
		const f = fixture(services, sshHost);
		f.state.selection = { kind: 'untitled', session: { untitledSessionId: 'draft', title: 'Draft', model: undefined, agent: undefined, workspace: { type: 'ssh', host: 'second-host', root: '/draft' } } };
		f.prepareWith(async () => assert.fail('Drafts have no durable link'));
		using commands = new CommandService(services);
		await commands.executeCommand(command);
		assert.deepEqual(requests, [{ folder: createSshRemoteWorkspaceUri('second-host', '/draft').toString(), conversation: undefined }]);
		assert.deepEqual(f.notifications, []);
	});

	test('opens an IDE without fabricating a directory for an empty selection', async () => {
		using services = new InstantiationService();
		const f = fixture(services, sshHost);
		f.state.selection = undefined;
		using commands = new CommandService(services);
		await commands.executeCommand(command);
		assert.deepEqual(requests, []);
		assert.deepEqual(f.windows, [{ forceReuseWindow: true }]);
	});

	test('does not open a stale conversation after navigation while its link is preparing', async () => {
		using services = new InstantiationService();
		const f = fixture(services, sshHost);
		const pending = new DeferredPromise<OpenSessionLink>();
		f.prepareWith(() => pending.p);
		using commands = new CommandService(services);
		const opening = commands.executeCommand(command);
		f.state.revision++;
		f.state.selection = undefined;
		await pending.complete(link);
		await opening;
		assert.deepEqual(requests, []);
		assert.deepEqual(f.windows, []);
		assert.deepEqual(f.notifications, []);
	});

	test('repeated clicks retain the same host and backend coordinates', async () => {
		using services = new InstantiationService();
		fixture(services, sshHost);
		using commands = new CommandService(services);
		await Promise.all([commands.executeCommand(command), commands.executeCommand(command)]);
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[0], requests[1]);
	});
});
