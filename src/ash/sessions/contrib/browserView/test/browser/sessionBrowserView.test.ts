import { TestWorkspaceTrustManagementService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue, type IReader } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewService, BrowserViewStorageScope, type BrowserViewEvent, type IBrowserViewInfo } from '../../../../../platform/browserView/common/browserView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../../../workbench/common/editor.js';
import { DialogsModel, IDialogsModel } from '../../../../../workbench/common/dialogs.js';
import type { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import type { EditorPartChangeEvent } from '../../../../../workbench/services/editor/common/editorState.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import type { AgentTreeNode, ISession, IUntitledChatSession, SessionWorkspaceSelection } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService, type SessionsManagementState } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionBrowserNetworkContribution } from '../../browser/sessionBrowserNetwork.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { SessionBrowserViewController } from '../../browser/sessionBrowserView.js';

const first = session('session-one', 'thread-one');
const second = session('session-two', 'thread-two');

suite('Session browser page policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a Main close supersedes queued archive cleanup instead of destroying the page twice', async () => {
		using f = fixture();
		const input = await f.create();
		f.catalog = [{ ...first, status: 'archived' }, second];
		f.catalogChanged.fire();
		await f.main.destroyBrowserView(input.id);
		await f.controller.onWorkspaceRestored();
		assert.deepEqual(f.destroyed, [input.id]);
	});

	test('foreground and background Thread pages share one Main owner and follow the selected Session', async () => {
		using f = fixture();
		const foreground = await f.create('thread-one');
		const background = await f.create('thread-two');
		assert.deepEqual(f.opened, [foreground]);
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [foreground]);
		f.selection.set(selected(second));
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [background]);
		assert.deepEqual([...f.views.getContextualBrowserViews({ activeSessionId: 'thread-one' }).values()], [foreground]);
		assert.deepEqual(f.destroyed, []);
		const model = await foreground.resolve();
		f.groupInputs.length = 0;
		f.editorEvents.fire({
			kind: 'groupChanged', groupId: 1, event: {
				kind: 'editorClosed', reason: 'reset', editor: {
					input: foreground, groupId: 1, instanceId: 'browser', paneId: 'browser', index: 0,
					isActive: true, isPreview: false, isSticky: false, isDirty: false, canRevert: false, hasExternalChange: false,
				},
			}
		});
		f.selection.set(selected(first));
		assert.equal(await foreground.resolve(), model);
		assert.equal(f.pages.has(foreground.id), true);
		assert.deepEqual(f.destroyed, []);
	});

	test('archiving and removal close only pages belonging to the affected Session', async () => {
		using f = fixture();
		const user = await f.create();
		const background = await f.create('thread-two');
		f.catalog = [{ ...first, status: 'archived' }, second];
		f.catalogChanged.fire();
		await f.controller.onWorkspaceRestored();
		assert.deepEqual(f.destroyed, [user.id]);
		assert.equal(user.isDisposed, true);
		assert.equal(f.views.getKnownBrowserViews().get(background.id), background);
		f.state = 'loading';
		f.catalog = [];
		f.catalogChanged.fire();
		await f.controller.onWorkspaceRestored();
		assert.deepEqual(f.destroyed, [user.id]);
		f.state = 'ready';
		f.catalogChanged.fire();
		await f.controller.onWorkspaceRestored();
		assert.deepEqual(f.destroyed, [user.id, background.id]);
		assert.equal(f.views.getKnownBrowserViews().size, 0);
	});

	test('draft promotion preserves browser ownership and an error catalog does not close pages', async () => {
		using f = fixture();
		const draft: IUntitledChatSession = { untitledSessionId: 'draft-one', title: 'Draft', model: undefined, agent: undefined, workspace: { type: 'current' } };
		f.drafts = [draft];
		f.selection.set({ kind: 'untitled', session: draft });
		const input = await f.create();
		f.materialized.set(new Map([[draft.untitledSessionId, { sessionId: first.sessionId, threadId: 'thread-one' }]]));
		f.drafts = [];
		f.selection.set(selected(first));
		f.catalogChanged.fire();
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [input]);
		f.state = 'error';
		f.catalog = [];
		f.catalogChanged.fire();
		await f.controller.onWorkspaceRestored();
		assert.deepEqual(f.destroyed, []);
	});

	test('nested Agent Thread pages belong to their root Session rather than the foreground Session', async () => {
		using f = fixture();
		f.catalog = [first, { ...second, agentTree: [node('thread-two', [node('peer-thread', [node('child-thread')])])] }];
		f.catalogChanged.fire();
		const child = await f.create('child-thread');
		assert.deepEqual(f.opened, []);
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], []);
		f.selection.set(selected(second));
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [child]);
		f.controller.dispose();
		assert.deepEqual(f.destroyed, []);
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [child]);
	});

	test('catalog discovery resolves background ownership without opening a tab during loading', async () => {
		using f = fixture();
		f.state = 'loading';
		f.catalog = [];
		f.catalogChanged.fire();
		await f.views.initialize();
		const info = await f.main.getOrCreateBrowserView('browser_target_' + crypto.randomUUID(), { initialUrl: 'about:blank', owner: { type: 'agent', sessionId: 'thread-two' }, session: { scope: BrowserViewStorageScope.Agent, affinity: 'thread-two' } });
		const input = f.views.getKnownBrowserViews().get(info.id)!;
		assert.equal(f.opened.length, 0);
		f.catalog = [first, second];
		f.state = 'ready';
		f.catalogChanged.fire();
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], []);
		f.selection.set(selected(second));
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [input]);
	});
});

suite('Session browser networks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('network selection follows the owning Thread, independently of the foreground and window', async () => {
		using f = fixture();
		f.catalog = [
			{ ...first, workspace: { authorityId: 'local', root: '/local' } },
			{
				...second, workspace: { authorityId: 'ssh+host-b', root: '/repo' }, chats: [
					{ ...second.chats[0]!, workspace: { authorityId: 'ssh+host-c', root: '/other' } },
				]
			},
		];
		f.selection.set(selected(f.catalog[0]!));
		f.windowRemote = 'ssh+window-host';
		assert.equal(f.views.resolveNetwork({ type: 'user' }), undefined);
		assert.deepEqual(f.views.resolveNetwork({ type: 'agent', sessionId: 'thread-two' }), { authority: 'ssh+host-c', root: '/other' });
		assert.throws(() => f.views.resolveNetwork({ type: 'agent', sessionId: 'removed-thread' }), /BrowserOwnerNetworkUnavailable/);
		f.catalog = [{ ...second, workspace: { authorityId: 'wsl+abc', root: '/repo' } }];
		assert.deepEqual(f.views.resolveNetwork({ type: 'agent', sessionId: 'thread-two' }), { authority: 'wsl+abc', root: '/repo' });
	});

	test('workspace-less remote sessions use the provider domain and ambiguous or container drafts never fall back to the source network', () => {
		using f = fixture();
		f.catalog = [{ ...first, providerId: 'remote-provider', workspace: null }];
		f.providerWorkspace = { type: 'ssh', host: 'provider-host', root: '/repo' };
		assert.deepEqual(f.views.resolveNetwork({ type: 'agent', sessionId: 'thread-one' }), { authority: 'ssh+provider-host', root: '/repo' });
		const container: IUntitledChatSession = { ...draft('container', 'source-host', '/repo'), workspace: { type: 'provider', providerId: 'container', workspace: 'runtime', root: '/workspace', hostAuthority: 'ssh+source-host' } };
		f.selection.set({ kind: 'untitled', session: container });
		assert.equal(f.views.resolveNetwork({ type: 'user' })!.authority.startsWith('provider-host+'), true);
		assert.equal(f.views.resolveNetwork({ type: 'user' })!.root, '/workspace');
		f.selection.set({
			kind: 'untitled', session: {
				...container, workspace: {
					type: 'multiple', folders: [
						{ label: 'local', target: { type: 'local', root: '/local' } },
						{ label: 'remote', target: { type: 'ssh', host: 'host-a', root: '/remote' } },
					]
				}
			}
		});
		assert.throws(() => f.views.resolveNetwork({ type: 'user' }), /BrowserOwnerNetworkUnavailable/);
	});

	test('local workspace storage retains its directory partition without recreating the tab on catalog refresh', async () => {
		using f = fixture();
		f.workbenchState = WorkbenchState.EMPTY;
		await f.configuration.updateValue('workbench.browser.dataStorage', 'workspace', ConfigurationTarget.MEMORY);
		const local: IUntitledChatSession = { ...draft('local', 'unused', '/repo'), workspace: { type: 'local', root: '/repo' } };
		f.drafts = [local]; f.selection.set({ kind: 'untitled', session: local });
		const input = await f.create();
		f.catalogChanged.fire(); await flush();
		assert.equal(f.replacements.length, 0);
		assert.deepEqual(input.model!.info.session, { scope: BrowserViewStorageScope.Workspace, affinity: '["local","/repo"]' });
	});

	test('multiple container roots retain a real execution directory and isolate storage by the complete root set', async () => {
		using f = fixture();
		const folder = (root: string) => ({ label: root, target: { type: 'provider' as const, providerId: 'container', workspace: 'runtime', root } });
		const container: IUntitledChatSession = { ...draft('container', 'unused', '/a'), workspace: { type: 'multiple', folders: [folder('/b'), folder('/a')] } };
		f.drafts = [container]; f.selection.set({ kind: 'untitled', session: container });
		const input = await f.create();
		const network = f.views.resolveNetwork({ type: 'user' })!;
		assert.equal(network.root, '/b');
		assert.deepEqual(input.model!.info.session, { scope: BrowserViewStorageScope.Workspace, network, affinity: JSON.stringify([network.authority, ['/a', '/b']]) });
	});

	test('ephemeral container tabs move when the execution root changes within the same runtime', async () => {
		using f = fixture();
		await f.configuration.updateValue('workbench.browser.dataStorage', 'ephemeral', ConfigurationTarget.MEMORY);
		const container: IUntitledChatSession = { ...draft('container', 'unused', '/a'), workspace: { type: 'provider', providerId: 'container', workspace: 'runtime', root: '/a' } };
		f.drafts = [container]; f.selection.set({ kind: 'untitled', session: container });
		const input = await f.create();
		f.drafts = [{ ...container, workspace: { type: 'provider', providerId: 'container', workspace: 'runtime', root: '/b' } }];
		f.catalogChanged.fire(); await flush();
		assert.equal(f.replacements.length, 1);
		assert.equal(f.replacements[0]!.from, input);
		assert.deepEqual(f.replacements[0]!.to.model!.info.session, { scope: BrowserViewStorageScope.Ephemeral, network: { ...f.views.resolveNetwork({ type: 'user' }), root: '/b' } });
	});

	test('a failed network replacement retires its reservation while preserving the original page', async () => {
		using f = fixture();
		const original = draft('draft', 'host-a', '/repo');
		f.drafts = [original]; f.selection.set({ kind: 'untitled', session: original });
		const input = await f.create();
		f.main.getOrCreateBrowserView = async () => { throw new Error('Proxy failed'); };
		await assert.rejects(f.views.replaceBrowserView(input, { scope: BrowserViewStorageScope.Ephemeral, network: { authority: 'ssh+failed' } }), /Proxy failed/);
		assert.deepEqual([...f.views.getKnownBrowserViews().keys()], [input.id]);
		assert.equal(f.pages.has(input.id), true);
		assert.equal(f.replacements.length, 0);
		assert.equal(f.groupInputs[0], input);
	});

	test('creation captures its draft network before asynchronous discovery and keeps its original Session visibility', async () => {
		using f = fixture();
		const original = draft('original', 'host-a', '/project');
		const another = draft('another', 'host-b', '/other');
		f.drafts = [original, another];
		f.selection.set({ kind: 'untitled', session: original });
		const discovery = promiseWithResolvers<IBrowserViewInfo[]>();
		f.main.getBrowserViews = () => discovery.promise;
		const pending = f.views.createBrowserView({ initialUrl: 'http://localhost:3000/', owner: { type: 'user' } });
		f.selection.set({ kind: 'untitled', session: another });
		discovery.resolve([]);
		const input = await pending;
		assert.deepEqual(input.model!.info.session, {
			scope: BrowserViewStorageScope.Workspace,
			network: { authority: 'ssh+host-a', root: '/project' }, affinity: '["ssh+host-a","/project"]',
		});
		assert.equal(f.opened.length, 0);
		assert.equal(f.views.getContextualBrowserViews().size, 0);
		f.selection.set({ kind: 'untitled', session: original });
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [input]);
	});

	test('only visible tabs of the changed draft move, retaining their URL and storage scope', async () => {
		using f = fixture();
		const a = draft('a', 'host-a', '/repo');
		const b = draft('b', 'host-b', '/repo');
		f.drafts = [a, b];
		f.selection.set({ kind: 'untitled', session: a });
		const visible = await f.create();
		const hidden = await f.create();
		f.groupInputs.splice(f.groupInputs.indexOf(hidden), 1);
		f.selection.set({ kind: 'untitled', session: b });
		const other = await f.create();
		f.drafts = [{ ...a, workspace: { type: 'ssh', host: 'host-c', root: '/changed' } }, b];
		f.catalogChanged.fire();
		await flush();
		assert.equal(f.replacements.length, 1);
		assert.equal(f.replacements[0]!.from, visible);
		assert.deepEqual(f.replacements[0]!.to.serialize(), {
			...visible.serialize(), id: f.replacements[0]!.to.id,
			session: { scope: BrowserViewStorageScope.Workspace, network: { authority: 'ssh+host-c', root: '/changed' }, affinity: '["ssh+host-c","/changed"]' },
		});
		assert.equal(hidden.model!.info.session.scope, BrowserViewStorageScope.Workspace);
		assert.equal(other.model!.info.session.scope, BrowserViewStorageScope.Workspace);
		assert.deepEqual(f.groupInputs.map(input => input.resource.toString()), [f.replacements[0]!.to, other].map(input => input.resource.toString()));
		assert.deepEqual([...f.views.getContextualBrowserViews().keys()], [other.id]);
	});

	test('promotion moves to the materialized execution directory and ends draft tracking', async () => {
		using f = fixture();
		const original = draft('draft', 'host-a', '/repo');
		f.drafts = [original];
		f.selection.set({ kind: 'untitled', session: original });
		const input = await f.create();
		f.catalog = [{ ...first, workspace: { authorityId: 'ssh+host-b', root: '/runtime' } }];
		f.materialized.set(new Map([['draft', { sessionId: first.sessionId, threadId: 'thread-one' }]]));
		f.drafts = [];
		f.selection.set(selected(f.catalog[0]!));
		f.catalogChanged.fire();
		await flush();
		assert.equal(f.replacements.length, 1);
		assert.equal(f.replacements[0]!.from, input);
		assert.deepEqual(f.replacements[0]!.to.model!.info.session, { scope: BrowserViewStorageScope.Workspace, network: { authority: 'ssh+host-b', root: '/runtime' }, affinity: '["ssh+host-b","/runtime"]' });
		f.catalog = [{ ...first, workspace: { authorityId: 'ssh+host-c', root: '/later' } }];
		f.catalogChanged.fire();
		await flush();
		assert.equal(f.replacements.length, 1);
	});
});

function draft(id: string, host: string, root: string): IUntitledChatSession {
	return { untitledSessionId: id, title: id, model: undefined, agent: undefined, workspace: { type: 'ssh', host, root } };
}

function flush(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

function session(sessionId: string, threadId: string): ISession {
	return { sessionId, kind: 'code' as const, title: sessionId, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId, origin: { type: 'root' }, status: 'active' }] };
}

function selected(session: ISession): SessionsViewSelection {
	return { kind: 'session', active: { session, threadId: session.chats[0]!.threadId } };
}

function node(threadId: string, children: readonly AgentTreeNode[] = []): AgentTreeNode {
	return { threadId, threadSequence: 1, title: threadId, origin: { type: 'root' }, membershipStatus: 'active', executionStatus: 'idle', usage: { inputTokens: 0, outputTokens: 0 }, joins: [], children };
}

function fixture() {
	const resources = new DisposableStore();
	const events = resources.add(new Emitter<BrowserViewEvent>());
	const editorEvents = resources.add(new Emitter<EditorPartChangeEvent>());
	const catalogChanged = resources.add(new Emitter<void>());
	const selection = observableValue<SessionsViewSelection | undefined>('browser foreground', selected(first));
	const materialized = observableValue<ReadonlyMap<string, { sessionId: string; threadId: string; }>>('browser draft promotion', new Map());
	const f = {
		pages: new Map<string, IBrowserViewInfo>(), catalog: [first, second] as readonly ISession[], drafts: [] as readonly IUntitledChatSession[],
		workbenchState: WorkbenchState.FOLDER, windowRemote: undefined as string | undefined, providerWorkspace: undefined as SessionWorkspaceSelection | undefined,
		replacements: [] as { from: BrowserEditorInput; to: BrowserEditorInput; }[],
		state: 'ready' as SessionsManagementState, opened: [] as IResourceEditorInput[], groupInputs: [] as IResourceEditorInput[], destroyed: [] as string[],
		selection, materialized, catalogChanged, editorEvents,
	};
	const management = {
		onDidChange: catalogChanged.event, materializedSessions: materialized,
		get sessions() { return f.catalog; }, get untitledSessions() { return f.drafts; }, get state() { return f.state; },
	} as unknown as ISessionsManagementService;
	const sessions = {
		get activeSelection() { return selection.get(); },
		getSelection: (reader?: IReader) => { const active = selection.read(reader); return { activeSelection: active, visibleSelections: active ? [active] : [] }; },
	} as unknown as ISessionsService;
	const pages: IBrowserViewService = {
		setContentVisibility: async () => { },
		respondToPasswordSave: async () => { }, respondToPasswordFill: async () => { }, respondToAuthentication: async () => { }, setPermissions: async () => { }, respondToFileRequest: async () => { },
		toggleDevTools: async () => { }, clearStorage: async () => { }, setBrowserZoomIndex: async () => { }, setDeviceEmulation: async () => { },
		updateWindowConfiguration: async () => { }, getConsoleLogs: async () => '', getSelectedText: async () => '', getAccessibilityTree: async () => '', findInPage: async () => { }, stopFindInPage: async () => { },
		toggleElementSelection: async () => { }, setElementComments: async () => { }, toggleAreaSelection: async () => { }, captureScreenshot: async () => { throw new Error('Unexpected screenshot'); },
		getBrowserHistory: async () => ({ items: [] }), deleteBrowserHistory: async () => { },
		getBrowserViews: async () => [...f.pages.values()],
		getOrCreateBrowserView: async (id, options) => {
			const existing = f.pages.get(id);
			if (existing) { return existing; }
			const info: IBrowserViewInfo = { id, host: { windowId: 1 }, owner: options.owner, session: options.session, state: { isDevToolsOpen: false, targetId: id, url: options.initialUrl, title: '', loading: false, canGoBack: false, canGoForward: false, visible: false } };
			f.pages.set(id, info);
			events.fire({ type: 'created', info });
			return info;
		},
		getState: async id => f.pages.get(id)!.state,
		getSharing: async () => [], setSharing: async () => { }, respondToPermission: async () => { }, clearPermissions: async () => { }, cancelDownloads: async () => { },
		loadURL: async () => { }, goBack: async () => { }, goForward: async () => { }, reload: async () => { }, stop: async () => { }, focus: async () => { }, layout: async () => { }, setVisible: async () => { },
		destroyBrowserView: async id => { f.destroyed.push(id); f.pages.delete(id); events.fire({ type: 'closed', targetId: id }); },
		onDidEvent: events.event,
	};
	const editors: IEditorService = {
		...emptyEditorServiceState,
		onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], focusActiveEditor: () => { },
		openEditor: async input => {
			f.opened.push(input);
			if ('resolve' in input && typeof input.resolve === 'function') { await input.resolve(); }
			f.groupInputs.push(input);
		},
	};
	const editorPart = {
		onDidChangeEditors: editorEvents.event,
		groups: [{
			inputs: f.groupInputs,
			replaceEditor: async (from: BrowserEditorInput, to: BrowserEditorInput) => {
				f.replacements.push({ from, to });
				f.groupInputs.splice(f.groupInputs.indexOf(from), 1, to);
			},
			closeEditor: async (input: IResourceEditorInput) => { f.groupInputs.splice(f.groupInputs.indexOf(input), 1); return true; }
		}],
	} as unknown as IEditorPart;
	const dialogs = resources.add(new DialogsModel());
	const configuration = resources.add(new InMemoryConfigurationService());
	const services = resources.add(new InstantiationService(new ServiceCollection(
		[IConfigurationService, configuration],
		[IWorkspaceContextService, {
			onDidChangeWorkspace: Event.None,
			onDidChangeWorkspaceFolders: Event.None,
			onDidChangeWorkbenchState: Event.None,
			onDidChangeWorkspaceName: Event.None, getWorkspace: () => ({ id: 'browser-test', folders: [], remoteAuthority: f.windowRemote }), getWorkbenchState: () => f.workbenchState, getWorkspaceFolder: () => null
		}],
		[IWorkspaceTrustManagementService, resources.add(Object.assign(new TestWorkspaceTrustManagementService(), { onDidChangeTrust: Event.None, getUriTrustInfo: async (uri: import('../../../../../base/common/uri.js').URI) => ({ uri, trusted: true, permissions: undefined }), getWorkspaceTrustInfo: async () => ({ isTrusted: true, isReadOnly: false }) } satisfies Partial<IWorkspaceTrustManagementService>))],
		[IFileService, { readFileBytes: async () => { throw new Error('No test file configured'); } } as unknown as IFileService], [IBrowserViewService, pages], [IEditorService, editors], [IEditorPart, editorPart], [IDialogsModel, dialogs],
		[ITelemetryService, new NullTelemetryServiceShape()], [ILogService, new NullLoggerService()],
		[ISessionsProvidersService, { getProvider: () => f.providerWorkspace ? { currentWorkspace: () => f.providerWorkspace } : undefined } as unknown as ISessionsProvidersService],
		[IAgentHostConnectionsService, { _serviceBrand: undefined, onDidChangeConnections: Event.None, connections: [], resolveConnection: () => undefined } as unknown as IAgentHostConnectionsService], [ISessionsManagementService, management], [ISessionsService, sessions],
	)));
	const views = resources.add(services.createInstance(BrowserViewWorkbenchService));
	services.registerInstance(IBrowserViewWorkbenchService, views);
	const controller = resources.add(services.createInstance(SessionBrowserViewController));
	resources.add(services.createInstance(SessionBrowserNetworkContribution));
	return Object.assign(f, {
		views, controller, main: pages, configuration, [Symbol.dispose]: () => resources.dispose(),
		create: (threadId?: string) => views.createBrowserView({
			initialUrl: 'https://example.test/',
			owner: threadId ? { type: 'agent', sessionId: threadId } : { type: 'user' },
			...(threadId ? { session: { scope: BrowserViewStorageScope.Agent, affinity: threadId } } : {}),
		}),
	});
}

import { IFileService } from '../../../../../platform/files/common/files.js';

import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';

import '../../../../../workbench/contrib/browserView/electron-browser/features/browserDataStorageFeatures.js';
