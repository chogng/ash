import { TestWorkspaceTrustManagementService } from '../../../../test/common/workbenchTestServices.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewService, BrowserViewStorageScope, type BrowserViewEvent, type IBrowserViewInfo } from '../../../../../platform/browserView/common/browserView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { DialogsModel, IDialogsModel } from '../../../../common/dialogs.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { EditorPartChangeEvent } from '../../../../services/editor/common/editorState.js';
import { BrowserViewWorkbenchService } from '../../electron-browser/browserViewWorkbenchService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import '../../electron-browser/features/browserTabManagementFeatures.js';
import { DialogResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { readFile } from 'node:fs/promises';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';

const id = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
const info: IBrowserViewInfo = {
	id,
	host: { windowId: 1 },
	owner: { type: 'user' },
	session: { scope: BrowserViewStorageScope.Workspace },
	state: {
		targetId: id,
		url: 'https://example.test/',
		title: 'Original page',
		loading: false,
		visible: false,
		canGoBack: false,
		canGoForward: false,
	},
};

suite('Browser Workbench page lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Canvas pages are excluded from ordinary browser inputs and automatic tabs', async () => {
		using f = fixture();
		await f.views.initialize();
		const canvasId = 'browser_target_223e4567-e89b-12d3-a456-426614174000';
		const canvas = {
			...info,
			id: canvasId,
			canvas: { sessionId: 'session-one', instanceId: 'preview', title: 'Preview' },
			owner: { type: 'agent' as const, sessionId: 'thread-one' },
			state: { ...info.state, targetId: canvasId },
		};
		f.events.fire({ type: 'created', info: canvas });
		f.events.fire({ type: 'canvasOpened', targetId: canvasId, info: canvas });
		await Promise.resolve();
		assert.equal(f.views.getKnownBrowserViews().has(canvasId), false);
		assert.equal(f.opened.length, 0);
	});

	test('authentication uses translated masked inputs, defaults to no persistence and cancels retired requests', async () => {
		const chinese = JSON.parse(await readFile('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'));
		try {
			setNlsMessages('zh-CN', chinese);
			using f = fixture();
			await f.views.initialize();
			const dialogs = f.services.get(IDialogsModel);
			const answered = promiseWithResolvers<unknown>();
			f.service.respondToAuthentication = async (...args) => {
				answered.resolve(args);
			};
			const event = {
				type: 'authenticationRequested' as const,
				targetId: id,
				requestId: 'one',
				origin: 'https://private.test',
				realm: 'Private area',
				isProxy: false,
				canRemember: true,
				storageFailed: false,
			};
			f.events.fire(event);
			const dialog = dialogs.dialogs[0]!;
			assert.equal(dialog.request.kind, 'input');
			if (dialog.request.kind !== 'input') {
				throw new Error('Expected input dialog');
			}
			assert.deepEqual(
				[dialog.request.title, dialog.request.message, dialog.request.inputs, dialog.request.checkbox],
				['浏览器身份验证', '登录 https://private.test', [{ placeholder: '用户名' }, { type: 'password', placeholder: '密码' }], { label: '为此浏览器存储会话记住加密凭据', checked: false }],
			);
			dialog.close({ button: DialogResult.Primary, values: ['user', 'secret'], checkboxChecked: true });
			assert.deepEqual(await answered.promise, [id, 'one', { username: 'user', password: 'secret', remember: true }]);
			f.events.fire({ ...event, requestId: 'two', canRemember: false, storageFailed: true });
			assert.equal(dialogs.dialogs[0]!.request.checkbox, undefined);
			assert.match(dialogs.dialogs[0]!.request.detail!, /未加密/);
			let lateResponses = 0;
			f.service.respondToAuthentication = async () => {
				lateResponses++;
			};
			f.events.fire({ type: 'authenticationRequestClosed', targetId: id, requestId: 'two' });
			await Promise.resolve();
			assert.deepEqual([dialogs.dialogs.length, lateResponses], [0, 0]);
		} finally {
			resetNlsResolver();
		}
	});

	test('new user pages resolve storage preferences, remote isolation and live backend trust', async () => {
		using f = fixture();
		const create = () => f.views.createBrowserView({ initialUrl: 'https://example.test/', owner: { type: 'user' } });
		const first = await create();
		assert.equal(first.model!.info.session.scope, BrowserViewStorageScope.Global);
		await f.configuration.updateValue('workbench.browser.dataStorage', 'workspace', ConfigurationTarget.MEMORY);
		assert.equal((await create()).model!.info.session.scope, BrowserViewStorageScope.Workspace);
		assert.equal(first.model!.info.session.scope, BrowserViewStorageScope.Global);
		await f.configuration.updateValue('workbench.browser.dataStorage', 'global', ConfigurationTarget.MEMORY);
		f.remote = 'ssh-remote+test';
		assert.equal((await create()).model!.info.session.scope, BrowserViewStorageScope.Workspace);
		f.trusted = false;
		assert.equal((await create()).model!.info.session.scope, BrowserViewStorageScope.Ephemeral);
		f.trustUnavailable = true;
		assert.equal((await create()).model!.info.session.scope, BrowserViewStorageScope.Ephemeral);
		f.trustUnavailable = false;
		f.trusted = true;
		f.remote = undefined;
		f.state = WorkbenchState.EMPTY;
		await f.configuration.updateValue('workbench.browser.dataStorage', 'workspace', ConfigurationTarget.MEMORY);
		assert.equal((await create()).model!.info.session.scope, BrowserViewStorageScope.Ephemeral);
		const agent = await f.views.createBrowserView({
			initialUrl: 'https://example.test/',
			owner: { type: 'agent', sessionId: 'thread-one' },
			session: { scope: BrowserViewStorageScope.Agent, affinity: 'thread-one' },
		});
		assert.deepEqual(agent.model!.info.session, { scope: BrowserViewStorageScope.Agent, affinity: 'thread-one' });
	});

	test('registered navigation commands call the current page owner and hard reload preserves cache bypass', async () => {
		using f = fixture();
		await f.views.initialize();
		f.active = f.views.getKnownBrowserViews().get(id);
		const calls: string[] = [];
		f.service.goBack = async () => {
			calls.push('back');
		};
		f.service.goForward = async () => {
			calls.push('forward');
		};
		f.service.reload = async (_id, hard) => {
			calls.push(hard ? 'hard' : 'reload');
		};
		for (const command of ['goBack', 'goForward']) {
			await f.services.invokeFunction(CommandsRegistry.getCommand('workbench.action.browser.' + command)!);
		}
		assert.deepEqual(calls, []);
		f.events.fire({ type: 'stateChanged', state: { ...info.state, canGoBack: true, canGoForward: true } });
		for (const command of ['goBack', 'goForward', 'reload', 'hardReload']) {
			await f.services.invokeFunction(CommandsRegistry.getCommand('workbench.action.browser.' + command)!);
		}
		assert.deepEqual(calls, ['back', 'forward', 'reload', 'hard']);
	});

	test('the browser tab command lists contextual pages and rechecks ownership before opening a stale selection', async () => {
		using f = fixture();
		await f.views.initialize();
		using resources = new DisposableStore();
		const accepted = resources.add(new Emitter<void>());
		const hidden = resources.add(new Emitter<void>());
		const query = resources.add(new Emitter<string>());
		const shown = promiseWithResolvers<void>();
		type Pick = IQuickPickItem & { viewId?: string };
		const picker = {
			items: [] as Pick[],
			activeItems: [] as Pick[],
			selectedItems: [] as Pick[],
			value: '',
			ariaLabel: '',
			placeholder: '',
			sortByLabel: false,
			onDidHide: hidden.event,
			onDidAccept: accepted.event,
			onDidChangeValue: query.event,
			show: () => shown.resolve(),
			hide: () => hidden.fire(),
			dispose: () => {},
			[Symbol.dispose]: () => {},
		};
		f.services.registerInstance(IBrowserViewWorkbenchService, f.views);
		f.services.registerInstance(IQuickInputService, {
			createQuickPick: () => picker as unknown as IQuickPick<IQuickPickItem>,
		} as unknown as IQuickInputService);
		let included = true;
		using changed = new Emitter<void>();
		using filter = f.views.registerContextualFilter({ include: () => included, onDidChange: changed.event });
		const command = Promise.resolve(f.services.invokeFunction(CommandsRegistry.getCommand('workbench.action.browser.quickOpen')!));
		await shown.promise;
		assert.deepEqual(
			picker.items.map(item => item.label),
			['Original page', 'Open new browser tab'],
		);
		const selected = picker.items[0]!;
		picker.activeItems = [selected];
		f.events.fire({ type: 'stateChanged', state: { ...info.state, title: 'Changed title' } });
		assert.equal(picker.activeItems[0]!.viewId, id);
		assert.equal(picker.activeItems[0]!.label, 'Changed title');
		picker.selectedItems = [selected];
		included = false;
		changed.fire();
		assert.deepEqual(
			picker.items.map(item => item.label),
			['Open new browser tab'],
		);
		accepted.fire();
		await command;
		assert.deepEqual(f.opened, []);
	});

	test('open handlers suppress background presentation while retaining the Main page and owner', async () => {
		using f = fixture();
		const calls: string[] = [];
		using handler = f.views.registerOpenHandler({
			shouldOpenEditor: (_input, owner) => {
				calls.push(owner.type === 'agent' ? owner.sessionId : 'user');
				return owner.type === 'user';
			},
		});
		const input = await f.views.createBrowserView({
			initialUrl: 'https://example.test/background',
			owner: { type: 'agent', sessionId: 'background-thread' },
			session: { scope: BrowserViewStorageScope.Agent, affinity: 'background-thread' },
		});
		assert.deepEqual([calls, f.opened, f.destroyed, input.model?.info.owner], [['background-thread'], [], [], { type: 'agent', sessionId: 'background-thread' }]);
		assert.equal(f.views.getKnownBrowserViews().get(input.id), input);
	});

	test('Main-created pages consult the same open handlers and a removed handler permits the next page', async () => {
		using f = fixture();
		await f.views.initialize();
		const evaluated = promiseWithResolvers<void>();
		const handler = f.views.registerOpenHandler({
			shouldOpenEditor: () => {
				evaluated.resolve();
				return false;
			},
		});
		const targetId = 'browser_target_123e4567-e89b-12d3-a456-426614174001';
		f.events.fire({ type: 'created', info: { ...info, id: targetId, state: { ...info.state, targetId } } });
		await evaluated.promise;
		assert.deepEqual([f.opened, f.destroyed], [[], []]);
		handler.dispose();
		await f.views.createBrowserView({ initialUrl: 'about:blank', owner: { type: 'user' }, session: info.session });
		assert.equal(f.opened.length, 1);
	});

	test('context filters compose, notify consumers and keep sandbox storage restricted to its owner', async () => {
		using f = fixture();
		await f.views.initialize();
		const agentId = 'browser_target_123e4567-e89b-12d3-a456-426614174002';
		const owner = { type: 'agent' as const, sessionId: 'thread-two' };
		f.events.fire({
			type: 'created',
			info: {
				...info,
				id: agentId,
				owner,
				session: { scope: BrowserViewStorageScope.Agent, affinity: owner.sessionId },
				state: { ...info.state, targetId: agentId },
			},
		});
		await f.editorOpened.promise;
		using changed = new Emitter<void>();
		let allowedId = agentId;
		let notifications = 0;
		using listener = f.views.onDidChangeBrowserViews(() => notifications++);
		const filter = f.views.registerContextualFilter({
			include: input => input.id === allowedId,
			onDidChange: changed.event,
		});
		assert.deepEqual([...f.views.getContextualBrowserViews().keys()], [agentId]);
		assert.deepEqual([...f.views.getContextualBrowserViews({ sandboxSessionId: 'thread-one' }).keys()], []);
		assert.deepEqual([...f.views.getContextualBrowserViews({ sandboxSessionId: owner.sessionId }).keys()], [agentId]);
		allowedId = id;
		changed.fire();
		assert.deepEqual([...f.views.getContextualBrowserViews().keys()], [id]);
		filter.dispose();
		assert.deepEqual([...f.views.getContextualBrowserViews().keys()], [id, agentId]);
		assert.equal(notifications, 3);
	});

	test('new user pages record their source once without emitting a website address', async () => {
		using f = fixture();
		await f.views.createBrowserView({
			initialUrl: 'https://private.example.test/',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		assert.deepEqual(f.telemetryEvents, [{ name: 'integratedBrowser.open', data: { source: 'commandWithUrl' } }]);
	});

	test('close reaches model consumers and finishes closing the old editor before opening a replacement', async () => {
		using f = fixture();
		await f.views.initialize();
		const original = f.views.getKnownBrowserViews().get(id)!;
		const model = await original.resolve();
		f.groupInputs.push(original);
		const closing = promiseWithResolvers<void>();
		const closed = promiseWithResolvers<void>();
		f.closeEditor = async input => {
			closing.resolve();
			await closed.promise;
			f.groupInputs.splice(f.groupInputs.indexOf(input), 1);
			return true;
		};
		const received: string[] = [];
		using listener = model.onDidClose(() => {
			received.push('closed');
			f.info = { ...info, state: { ...info.state, title: 'Replacement page' } };
			f.events.fire({ type: 'created', info: f.info });
		});
		f.events.fire({ type: 'closed', targetId: id });
		assert.deepEqual(received, ['closed']);
		await closing.promise;
		assert.deepEqual(f.opened, []);
		closed.resolve();
		await f.editorOpened.promise;
		const replacement = f.views.getKnownBrowserViews().get(id)!;
		assert.deepEqual([original.isDisposed, replacement !== original, replacement.label, f.groupInputs, f.destroyed], [true, true, 'Replacement page', [replacement], []]);
	});

	test('Workbench shutdown releases an input whose page close is still pending', async () => {
		using f = fixture();
		await f.views.initialize();
		const input = f.views.getKnownBrowserViews().get(id)!;
		f.events.fire({ type: 'closed', targetId: id });
		f.views.dispose();
		assert.equal(input.isDisposed, true);
		await Promise.resolve();
	});

	test('creation rejects if Main closes the reserved page before returning its snapshot', async () => {
		using f = fixture();
		const snapshot = promiseWithResolvers<IBrowserViewInfo>();
		const requested = promiseWithResolvers<string>();
		f.service.getOrCreateBrowserView = async targetId => {
			requested.resolve(targetId);
			return snapshot.promise;
		};
		const creation = f.views.createBrowserView({
			initialUrl: 'about:blank',
			owner: { type: 'user' },
			session: info.session,
		});
		const targetId = await requested.promise;
		f.events.fire({ type: 'closed', targetId });
		snapshot.resolve({ ...info, id: targetId, state: { ...info.state, targetId } });
		await assert.rejects(creation, /BrowserTargetUnavailable/);
		assert.deepEqual([f.views.getKnownBrowserViews().has(targetId), f.opened], [false, []]);
	});

	test('initial discovery can recover after failure and still replay events received before its snapshot', async () => {
		using f = fixture();
		let attempts = 0;
		f.service.getBrowserViews = async () => {
			if (++attempts === 1) {
				throw new Error('Discovery unavailable');
			}
			return [];
		};
		f.events.fire({ type: 'created', info });
		await assert.rejects(f.views.initialize(), /Discovery unavailable/);
		await f.views.initialize();
		await f.editorOpened.promise;
		assert.deepEqual([attempts, f.views.getKnownBrowserViews().size, f.opened.length], [2, 1, 1]);
	});

	test('restoration waits for a buffered close before exposing the initial page set', async () => {
		using f = fixture();
		const input = f.views.getOrCreateLazy({
			id,
			url: info.state.url,
			title: info.state.title,
			session: info.session,
		});
		f.groupInputs.push(input);
		const snapshot = promiseWithResolvers<readonly IBrowserViewInfo[]>();
		const closing = promiseWithResolvers<void>();
		const closed = promiseWithResolvers<void>();
		f.service.getBrowserViews = () => snapshot.promise;
		f.closeEditor = async () => {
			closing.resolve();
			await closed.promise;
			f.groupInputs.length = 0;
			return true;
		};
		let ready = false;
		const initialization = f.views.initialize().then(() => {
			ready = true;
		});
		f.events.fire({ type: 'closed', targetId: id });
		snapshot.resolve([info]);
		await closing.promise;
		await Promise.resolve();
		assert.equal(ready, false);
		closed.resolve();
		await initialization;
		assert.deepEqual([input.isDisposed, f.views.getKnownBrowserViews().size, f.groupInputs], [true, 0, []]);
	});
});

function fixture() {
	const resources = new DisposableStore();
	const events = resources.add(new Emitter<BrowserViewEvent>());
	const editorEvents = resources.add(new Emitter<EditorPartChangeEvent>());
	const f = {
		trusted: true,
		trustUnavailable: false,
		remote: undefined as string | undefined,
		state: WorkbenchState.FOLDER,
		active: undefined as IResourceEditorInput | undefined,
		info,
		events,
		editorEvents,
		groupInputs: [] as IResourceEditorInput[],
		opened: [] as IResourceEditorInput[],
		destroyed: [] as string[],
		editorOpened: promiseWithResolvers<void>(),
		closeEditor: async (input: IResourceEditorInput): Promise<boolean> => {
			f.groupInputs.splice(f.groupInputs.indexOf(input), 1);
			return true;
		},
	};
	const service: IBrowserViewService = {
		setContentVisibility: async () => {},
		respondToPasswordSave: async () => {},
		respondToPasswordFill: async () => {},
		respondToAuthentication: async () => {},
		setPermissions: async () => {},
		respondToFileRequest: async () => {},
		toggleDevTools: async () => {},
		clearStorage: async () => {},
		setBrowserZoomIndex: async () => {},
		setDeviceEmulation: async () => {},
		updateWindowConfiguration: async () => {},
		getConsoleLogs: async () => '',
		getSelectedText: async () => '',
		getAccessibilityTree: async () => '',
		findInPage: async () => {},
		stopFindInPage: async () => {},
		toggleElementSelection: async () => {},
		setElementComments: async () => {},
		toggleAreaSelection: async () => {},
		captureScreenshot: async () => {
			throw new Error('Unexpected screenshot');
		},
		getBrowserHistory: async () => ({ items: [] }),
		deleteBrowserHistory: async () => {},
		getBrowserViews: async () => [f.info],
		getOrCreateBrowserView: async (targetId, options) => ({
			...f.info,
			id: targetId,
			owner: options.owner,
			session: options.session,
			state: { ...f.info.state, targetId, url: options.initialUrl },
		}),
		getState: async targetId => ({ ...f.info.state, targetId }),
		getSharing: async () => [],
		setSharing: async () => {},
		respondToPermission: async () => {},
		clearPermissions: async () => {},
		cancelDownloads: async () => {},
		loadURL: async () => {},
		goBack: async () => {},
		goForward: async () => {},
		reload: async () => {},
		stop: async () => {},
		focus: async () => {},
		layout: async () => {},
		setVisible: async () => {},
		destroyBrowserView: async targetId => {
			f.destroyed.push(targetId);
		},
		onDidEvent: events.event,
	};
	const editors: IEditorService = {
		...emptyEditorServiceState,
		onDidActiveEditorChange: Event.None,
		onDidVisibleEditorsChange: Event.None,
		get activeEditor() {
			return f.active;
		},
		visibleEditors: [],
		focusActiveEditor: () => {},
		openEditor: async input => {
			f.opened.push(input);
			if ('resolve' in input && typeof input.resolve === 'function') {
				await input.resolve();
			}
			f.groupInputs.push(input);
			f.editorOpened.resolve();
		},
	};
	const editorPart = {
		onDidChangeEditors: editorEvents.event,
		groups: [{ inputs: f.groupInputs, closeEditor: (input: IResourceEditorInput) => f.closeEditor(input) }],
	} as unknown as IEditorPart;
	const dialogs = resources.add(new DialogsModel());
	const telemetryEvents: Array<{ name: string; data: unknown }> = [];
	const telemetry = new NullTelemetryServiceShape();
	telemetry.publicLog2 = (name, data) => {
		telemetryEvents.push({ name, data });
	};
	const configuration = resources.add(new InMemoryConfigurationService());
	const services = resources.add(
		new InstantiationService(
			new ServiceCollection(
				[IConfigurationService, configuration],
				[
					IWorkspaceContextService,
					{
						onDidChangeWorkspace: Event.None,
						onDidChangeWorkspaceFolders: Event.None,
						onDidChangeWorkbenchState: Event.None,
						onDidChangeWorkspaceName: Event.None,
						getWorkspace: () => ({
							id: 'browser-test',
							folders: [],
							...(f.remote ? { remoteAuthority: f.remote } : {}),
						}),
						getWorkbenchState: () => f.state,
						getWorkspaceFolder: () => null,
					},
				],
				[
					IWorkspaceTrustManagementService,
					resources.add(
						Object.assign(new TestWorkspaceTrustManagementService(), {
							onDidChangeTrust: Event.None,
							getUriTrustInfo: async (uri: import('../../../../../base/common/uri.js').URI) => ({
								uri,
								trusted: true,
								permissions: undefined,
							}),
							getWorkspaceTrustInfo: async () => {
								if (f.trustUnavailable) {
									throw new Error('Backend unavailable');
								}
								return { isTrusted: f.trusted, isReadOnly: false };
							},
						} satisfies Partial<IWorkspaceTrustManagementService>),
					),
				],
				[
					IFileService,
					{
						readFileBytes: async () => {
							throw new Error('No test file configured');
						},
					} as unknown as IFileService,
				],
				[IBrowserViewService, service],
				[IEditorService, editors],
				[IEditorPart, editorPart],
				[IDialogsModel, dialogs],
				[ITelemetryService, telemetry],
			),
		),
	);
	const views = resources.add(services.createInstance(BrowserViewWorkbenchService));
	return Object.assign(f, {
		[Symbol.dispose]: () => resources.dispose(),
		views,
		service,
		services,
		telemetryEvents,
		configuration,
	});
}

import { IFileService } from '../../../../../platform/files/common/files.js';

import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import '../../electron-browser/features/browserDataStorageFeatures.js';

import '../../electron-browser/features/browserNavigationFeatures.js';
