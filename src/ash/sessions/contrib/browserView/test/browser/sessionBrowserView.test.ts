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
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import type { EditorPartChangeEvent } from '../../../../../workbench/services/editor/common/editorState.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import type { AgentTreeNode, ISession, IUntitledChatSession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService, type SessionsManagementState } from '../../../../services/sessions/common/sessionsManagement.js';
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
		const input = await f.create('thread-two');
		assert.deepEqual(f.opened, []);
		f.catalog = [first, second];
		f.state = 'ready';
		f.catalogChanged.fire();
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], []);
		f.selection.set(selected(second));
		assert.deepEqual([...f.views.getContextualBrowserViews().values()], [input]);
	});
});

function session(sessionId: string, threadId: string): ISession {
	return { sessionId, title: sessionId, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId, origin: { type: 'root' }, status: 'active' }] };
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
		updateWindowConfiguration: async () => { }, getConsoleLogs: async () => '', getSelectedText: async () => '', findInPage: async () => { }, stopFindInPage: async () => { },
		toggleElementSelection: async () => { }, setElementComments: async () => { }, toggleAreaSelection: async () => { }, captureScreenshot: async () => { throw new Error('Unexpected screenshot'); },
		getBrowserHistory: async () => ({ items: [] }), deleteBrowserHistory: async () => { },
		getBrowserViews: async () => [...f.pages.values()],
		getOrCreateBrowserView: async (id, options) => {
			const existing = f.pages.get(id);
			if (existing) { return existing; }
			const info: IBrowserViewInfo = { id, host: { windowId: 1 }, owner: options.owner, session: options.session, state: { targetId: id, url: options.initialUrl, title: '', loading: false, canGoBack: false, canGoForward: false, visible: false } };
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
		groups: [{ inputs: f.groupInputs, closeEditor: async (input: IResourceEditorInput) => { f.groupInputs.splice(f.groupInputs.indexOf(input), 1); return true; } }],
	} as unknown as IEditorPart;
	const dialogs = resources.add(new DialogsModel());
	const configuration = resources.add(new InMemoryConfigurationService());
	const services = resources.add(new InstantiationService(new ServiceCollection(
		[IConfigurationService, configuration],
		[IWorkspaceContextService, {
			onDidChangeWorkspace: Event.None,
			onDidChangeWorkspaceFolders: Event.None,
			onDidChangeWorkbenchState: Event.None,
			onDidChangeWorkspaceName: Event.None, getWorkspace: () => ({ id: 'browser-test', folders: [] }), getWorkbenchState: () => WorkbenchState.FOLDER, getWorkspaceFolder: () => null
		}],
		[IWorkspaceTrustManagementService, resources.add(Object.assign(new TestWorkspaceTrustManagementService(), { onDidChangeTrust: Event.None, getUriTrustInfo: async (uri: import('../../../../../base/common/uri.js').URI) => ({ uri, trusted: true, permissions: undefined }), getWorkspaceTrustInfo: async () => ({ isTrusted: true, isReadOnly: false }) } satisfies Partial<IWorkspaceTrustManagementService>))],
		[IFileService, { readFileBytes: async () => { throw new Error('No test file configured'); } } as unknown as IFileService], [IBrowserViewService, pages], [IEditorService, editors], [IEditorPart, editorPart], [IDialogsModel, dialogs],
		[ITelemetryService, new NullTelemetryServiceShape()], [ISessionsManagementService, management], [ISessionsService, sessions],
	)));
	const views = resources.add(services.createInstance(BrowserViewWorkbenchService));
	services.registerInstance(IBrowserViewWorkbenchService, views);
	const controller = resources.add(services.createInstance(SessionBrowserViewController));
	return Object.assign(f, {
		views, controller, main: pages, [Symbol.dispose]: () => resources.dispose(),
		create: (threadId?: string) => views.createBrowserView({
			initialUrl: 'https://example.test/',
			owner: threadId ? { type: 'agent', sessionId: threadId } : { type: 'user' },
			session: threadId ? { scope: BrowserViewStorageScope.Agent, affinity: threadId } : { scope: BrowserViewStorageScope.Workspace },
		}),
	});
}

import { IFileService } from '../../../../../platform/files/common/files.js';

import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
