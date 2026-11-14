import { constObservable, observableValue } from '../../../base/common/observable.js';
import { DesktopMainEditorPart } from '../../browser/parts/desktopEditorPart.js';
import { EditorParts } from '../../browser/parts/editorParts.js';
import { createDesktopEditorTestServices } from './desktopEditorTestServices.js';
import { createTestEditorServices, createTestComponentServices, registerTestComponentServices } from '../../../workbench/test/common/testEditorServices.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import '../../../editor/test/browser/testEditorDom.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { sessionsPartIds, type SessionsPartId } from '../../common/layoutConstants.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Dimension } from '../../../base/browser/dom.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { Part } from '../../../workbench/browser/part.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { registerLayoutActions } from '../../browser/layoutActions.js';
import { registerSessionsTerminalContribution } from '../../contrib/terminal/browser/sessionsTerminalContribution.js';
import { DesktopWorkbenchLayout } from '../../browser/desktopWorkbench.js';
import { Menus } from '../../browser/menus.js';
import { CanGoBackContext, CanGoForwardContext, SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { PanelMaximizedContext, PanelPositionContext } from '../../../workbench/common/contextkeys.js';
import { Position } from '../../../workbench/services/layout/browser/layoutService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { EditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { ITerminalService, ITerminalEditorService, type ITerminalInstance, type ICreateTerminalOptions, type TerminalEditorLocation } from '../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';

class TestPart extends Part {
	public getTabsHeight(): number { return 35; }
	public setContentRightInset(_inset: number): void { }
	public setEditorContentVisible(_visible: boolean): void { }
	constructor(container: HTMLElement, id: SessionsPartId) {
		const services = createTestComponentServices(undefined, undefined, container.ownerDocument);
		super(container, id, services.get(IThemeService), services.get(IStorageService));
		this._register(services);
	}
}

test('Sessions layout commands update menu state from their owners and release window registrations', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']);
	using resources = new DisposableStore();
	using changed = new Emitter<void>();
	using contextKeys = new ContextKeyService();
	contextKeys.setContext('sessions.desktopCode', true);
	using services = new InstantiationService();
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	const parts = new Map<SessionsPartId, Part>(sessionsPartIds.map(id => [id, resources.add(new TestPart(browser.window.document.body, id))]));
	const editorServices = resources.add(registerTestComponentServices(createTestEditorServices(undefined, undefined, browser.window.document), browser.window.document));
	const hosts = resources.add(createDesktopEditorTestServices(editorServices, {}, browser.window.document));
	parts.set('editor', hosts.area);
	using layout = createLayout(browser.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
	let historyIndex = 1;
	let activeSelection: ISessionsService['activeSelection'];
	const sessions: ISessionsService = {
		chatSelection: constObservable(undefined), getChatSelection: () => undefined, async restoreChatSelection() { },
		openChatDraft() { }, selectChatThread() { }, setChatModelPreference() { },
		navigationRevision: 0,
		getLastViewedAt: () => undefined,
		markVisibleThreadViewed() { },
		getSelection() { return { visibleSelections: [], activeSelection }; },
		async openThread() { },
		onDidChange: changed.event,
		visibleSelections: [],
		get activeSelection() { return activeSelection; },
		get canNavigateBack() { return historyIndex === 1; },
		get canNavigateForward() { return historyIndex === 0; },
		recentSessions: [],
		async initialize() { },
		async openSession() { },
		async openUntitledSession() { },
		openNewSession() { throw new Error('This scenario does not create sessions'); },
		activateSelection() { },
		closeVisibleSelection() { },
		async reopenLastClosedItem() { },
		recordEntryNavigation() { },
		async openPreviousSession() { historyIndex = 0; changed.fire(); },
		async openNextSession() { historyIndex = 1; changed.fire(); },
	};
	const hasDesktopChatSource = observableValue('Chat view is active', false);
	using actions = registerLayoutActions(layout, sessions, contextKeys, hosts.editor, editorServices.get(IWorkspaceContextService), hasDesktopChatSource);
	using terminal = registerSessionsTerminalContribution(layout, contextKeys, hosts.editor);
	using menu = new MenuService(commands, contextKeys).createMenu(Menus.TitleBarLeftLayout);
	using layoutMenu = new MenuService(commands, contextKeys).createMenu(Menus.TitleBarRightLayout);
	const state = (): unknown => menu.getActions().flatMap(([, actions]) => actions).filter(action => action.id !== 'ash.sessions.togglePanel').map(action => [action.label, action.tooltip, action.enabled, action.checked]);
	const navigationState = (): unknown => [contextKeys.getValue(CanGoBackContext.key), contextKeys.getValue(CanGoForwardContext.key)];
	try {
		const tools = layoutMenu.getActions().find(([group]) => group === '1_tools')?.[1];
		assert.deepEqual(tools?.map(action => [action.id, action.icon, action.enabled]), [
			['ash.sessions.openSideChat', Lxicon.chat, true],
			['ash.sessions.openIOSSimulator', Lxicon.deviceMobile, false],
		]);
		assert.equal(layoutMenu.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.togglePanel')?.enabled, true);
		activeSelection = {
			kind: 'untitled',
			session: { untitledSessionId: 'new', title: 'New', model: undefined, agent: undefined, workspace: { type: 'current' } },
		};
		changed.fire();
		assert.deepEqual(layoutMenu.getActions().flatMap(([, actions]) => actions).map(action => action.id), ['ash.sessions.togglePanel']);
		hasDesktopChatSource.set(true, undefined);
		assert.equal(layoutMenu.getActions().some(([group]) => group === '1_tools'), true);
		hasDesktopChatSource.set(false, undefined);
		assert.equal(layoutMenu.getActions().some(([group]) => group === '1_tools'), false);
		activeSelection = undefined;
		changed.fire();
		assert.equal(layoutMenu.getActions().some(([group]) => group === '1_tools'), true);
		assert.deepEqual(navigationState(), [true, false]);
		assert.equal(layoutMenu.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.togglePanel')?.enabled, true);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		using goMenu = new MenuService(commands, contextKeys).createMenu(MenuId.MenubarGoMenu);
		assert.deepEqual(goMenu.getActions().flatMap(([, actions]) => actions).filter(action => action.id.startsWith('ash.sessions.')).map(action => [action.id, action.enabled]), [
			['ash.sessions.back', true], ['ash.sessions.forward', false],
		]);
		await commands.executeCommand('ash.sessions.toggleSidebar');
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.deepEqual(state(), [['Show sidebar', 'Show sidebar', true, false], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		layout.showPart('sidebar');
		const opened: string[] = [];
		using openChat = CommandsRegistry.register('sessions.open.chat', () => { opened.push('chat'); });
		using openCode = CommandsRegistry.register('sessions.open.code', () => { opened.push('code'); });
		contextKeys.setContext('sessions.activity.projectsSelected', true);
		for (const mode of ['chat', 'code']) {
			contextKeys.setContext(SessionsWorkspaceModeContext.key, mode);
			layout.hidePart('sidebar');
			await commands.executeCommand('ash.sessions.toggleSidebar');
			assert.equal(layout.isPartVisible('sidebar'), true);
			assert.equal(contextKeys.getValue('sessions.activity.projectsSelected'), true);
		}
		assert.deepEqual(opened, [], 'Expanding navigation never opens a different page');
		await commands.executeCommand('ash.sessions.back');
		assert.deepEqual(navigationState(), [false, true]);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', false, undefined], ['Forward', 'Forward', true, undefined]]);
		await commands.executeCommand('ash.sessions.forward');
		assert.deepEqual(navigationState(), [true, false]);
		assert.deepEqual(state(), [['Hide sidebar', 'Hide sidebar', true, true], ['Back', 'Back', true, undefined], ['Forward', 'Forward', false, undefined]]);
		assert.equal(layoutMenu.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.togglePanel')?.enabled, true);
		actions.dispose();
		assert.deepEqual(navigationState(), [false, false]);
		assert.deepEqual(menu.getActions(), []);
		assert.equal(CommandsRegistry.getCommand('ash.sessions.toggleSidebar'), undefined);
		assert.equal(CommandsRegistry.getCommand('ash.sessions.openSideChat'), undefined);
		assert.equal(layoutMenu.getActions().some(([group]) => group === '1_tools'), false);
		assert.equal(changed.hasListeners(), false);
	} finally {
		actions.dispose();
		layout.dispose();
		resources.dispose();
		browser.window.close();
	}
});

for (const hidden of [false, true]) {
	test(`Sessions terminal toggle restarts a ${hidden ? 'hidden' : 'visible'} unavailable tab in its retained group`, async () => {
		using owner = new DisposableStore();
		const fixture = terminalLayoutFixture(owner);
		const { editor, commands, instances, attempts } = fixture;
		const stale = new TerminalEditorInput(URI.parse('vscode-terminal:/missing/1'));
		await editor.openEditor(stale, { pinned: true });
		const destination = editor.activeGroup;
		const document = { resource: URI.file('/fixture/notes.txt'), editorId: 'test.document' };
		await editor.openEditor(document, { pinned: true, inactive: true }, { groupId: destination.id });
		const documentGroup = editor.groups.find(group => group.inputs.includes(document))!;
		editor.setGroupVisible(documentGroup.id, true);
		const otherInstance = fixture.addInstance(URI.parse('vscode-terminal:/other-session/1'));
		const otherSession = new TerminalEditorInput(otherInstance.resource!, otherInstance);
		{
			using otherScope = editor.setGroupScope(id => id !== destination.id);
			await editor.openEditor(otherSession, { pinned: true });
		}
		const otherGroup = editor.activeGroup;
		owner.add(editor.setGroupScope(id => id !== otherGroup.id));
		editor.setGroupVisible(otherGroup.id, false);
		editor.activateGroup(destination.id);
		editor.setGroupVisible(destination.id, !hidden);
		const groupIds = editor.groups.map(group => group.id);

		await commands.executeCommand('ash.sessions.togglePanel');

		assert.equal(attempts.length, 1);
		assert.deepEqual(attempts[0]?.location, { viewColumn: destination.id });
		assert.deepEqual(editor.groups.map(group => group.id), groupIds);
		assert.equal(editor.activeGroup, destination);
		assert.equal(editor.isGroupVisible(destination.id), true);
		assert.deepEqual(destination.inputs, [stale]);
		assert.equal(documentGroup.inputs.includes(document), true);
		assert.notEqual(documentGroup, destination);
		assert.deepEqual(otherGroup.inputs, [otherSession]);
		assert.equal(editor.isGroupVisible(otherGroup.id), false);
		assert.equal(destination.activeInput, stale);
		assert.equal(stale.activeResource, instances[1]!.resource);

		await commands.executeCommand('ash.sessions.togglePanel');
		assert.equal(editor.isGroupVisible(destination.id), false);
		assert.equal(editor.isGroupVisible(documentGroup.id), true);
		await commands.executeCommand('ash.sessions.togglePanel');
		assert.equal(destination.activeInput, stale);
		assert.equal(attempts.length, 1, 'Toggling a live terminal retains its original shell');
	});
}

test('Sessions terminal toggle waits for process restoration before classifying a saved tab', async () => {
	using owner = new DisposableStore();
	const recovery = new DeferredPromise<void>();
	const fixture = terminalLayoutFixture(owner, { recovery: recovery.p });
	const stale = new TerminalEditorInput(URI.parse('vscode-terminal:/restoring/1'));
	await fixture.editor.openEditor(stale, { pinned: true });
	const group = fixture.editor.activeGroup;
	const toggling = fixture.commands.executeCommand('ash.sessions.togglePanel');
	assert.equal(fixture.attempts.length, 0);
	fixture.addInstance(stale.resource);
	recovery.complete();
	await toggling;
	assert.deepEqual(group.inputs, [stale]);
	assert.equal(fixture.editor.isGroupVisible(group.id), false);
	await fixture.commands.executeCommand('ash.sessions.togglePanel');
	assert.equal(fixture.editor.isGroupVisible(group.id), true);
	assert.equal(fixture.attempts.length, 0);
});

test('Sessions terminal toggle reuses a retained instance when the saved tab has a different resource', async () => {
	using owner = new DisposableStore();
	const fixture = terminalLayoutFixture(owner);
	const retained = fixture.addInstance(URI.parse('vscode-terminal:/retained/1'));
	const stale = new TerminalEditorInput(URI.parse('vscode-terminal:/missing/1'));
	await fixture.editor.openEditor(stale, { pinned: true });
	const group = fixture.editor.activeGroup;
	fixture.editor.setGroupVisible(group.id, false);
	await fixture.commands.executeCommand('ash.sessions.togglePanel');
	assert.equal(fixture.editor.activeGroup, group);
	assert.equal(fixture.editor.isGroupVisible(group.id), true);
	assert.deepEqual(group.inputs, [stale]);
	assert.equal(stale.terminalInstance, retained);
	assert.equal(fixture.attempts.length, 0);
});

test('Sessions terminal toggle retains the unavailable tab after launch failure and retries in the same group', async () => {
	using owner = new DisposableStore();
	const options = { creationError: new Error('Synthetic terminal launch failure') as Error | undefined };
	const fixture = terminalLayoutFixture(owner, options);
	const stale = new TerminalEditorInput(URI.parse('vscode-terminal:/missing/1'));
	await fixture.editor.openEditor(stale, { pinned: true });
	const group = fixture.editor.activeGroup;
	await assert.rejects(fixture.commands.executeCommand('ash.sessions.togglePanel'), options.creationError);
	assert.deepEqual(group.inputs, [stale]);
	assert.equal(fixture.instances.length, 0);
	options.creationError = undefined;
	await fixture.commands.executeCommand('ash.sessions.togglePanel');
	assert.equal(fixture.editor.activeGroup, group);
	assert.deepEqual(group.inputs, [stale]);
	assert.equal(stale.terminalInstance, fixture.instances[0]);
	assert.equal(fixture.instances.length, 1);
});

test('Sessions restarts the visible saved terminal in place and keeps a recovered shell', async () => {
	using owner = new DisposableStore();
	const fixture = terminalLayoutFixture(owner);
	const recovered = new TerminalEditorInput(fixture.addInstance(URI.parse('vscode-terminal:/recovered/1')).resource!);
	const saved = new TerminalEditorInput(URI.parse('vscode-terminal:/missing/1#Old%20Shell'));
	await fixture.editor.openEditor(recovered, { pinned: true });
	const group = fixture.editor.activeGroup;
	await fixture.editor.openEditor(saved, { pinned: true }, { groupId: group.id });
	await fixture.startRestoringTabs();

	assert.deepEqual(group.inputs, [recovered, saved]);
	assert.equal(group.activeInput, saved);
	assert.equal(saved.activeResource, fixture.instances[1]!.resource);
	assert.equal(saved.label, 'Shell');
	assert.equal(fixture.attempts.length, 1);
	assert.equal(typeof fixture.attempts[0]?.placeInEditor, 'function');
	assert.equal(fixture.attempts[0]?.preserveFocus, true);
});

test('Sessions terminal toggle coalesces repeated requests while a shell is opening', async () => {
	using owner = new DisposableStore();
	const creating = new DeferredPromise<void>();
	const created = new DeferredPromise<void>();
	const fixture = terminalLayoutFixture(owner, { creationGate: created.p, onCreate: () => creating.complete() });
	const first = fixture.commands.executeCommand('ash.sessions.togglePanel');
	await creating.p;
	const second = fixture.commands.executeCommand('ash.sessions.togglePanel');
	created.complete();
	await Promise.all([first, second]);
	assert.equal(fixture.attempts.length, 1);
	assert.equal(fixture.instances.length, 1);
	assert.equal(fixture.editor.getToolGroups(input => input instanceof TerminalEditorInput).length, 1);
});

test('Sessions terminal toggle keeps an inactive saved tab beside a live terminal', async () => {
	using owner = new DisposableStore();
	const fixture = terminalLayoutFixture(owner);
	const instance = fixture.addInstance(URI.parse('vscode-terminal:/live/1'));
	const first = URI.parse('vscode-terminal:/original/1');
	const live = new TerminalEditorInput(first);
	live.addPane(instance.resource!, Direction.Right);
	live.removePane(first);
	await fixture.editor.openEditor(live, { pinned: true });
	const group = fixture.editor.activeGroup;
	const stale = new TerminalEditorInput(URI.parse('vscode-terminal:/missing/1'));
	await fixture.editor.openEditor(stale, { pinned: true, inactive: true }, { groupId: group.id });
	await fixture.commands.executeCommand('ash.sessions.togglePanel');
	assert.deepEqual(group.inputs, [live, stale]);
	assert.equal(fixture.editor.isGroupVisible(group.id), false);
	await fixture.commands.executeCommand('ash.sessions.togglePanel');
	assert.equal(fixture.editor.isGroupVisible(group.id), true);
	assert.equal(group.activeInput, live);
	assert.equal(fixture.attempts.length, 0);
});

test('Sessions closes a replacement shell if the saved tab closes during launch', async () => {
	using owner = new DisposableStore();
	const creating = new DeferredPromise<void>();
	const gate = new DeferredPromise<void>();
	const fixture = terminalLayoutFixture(owner, { creationGate: gate.p, onCreate: () => creating.complete() });
	const saved = new TerminalEditorInput(URI.parse('vscode-terminal:/missing/1'));
	await fixture.editor.openEditor(saved, { pinned: true });
	const group = fixture.editor.activeGroup;
	const restoring = fixture.startRestoringTabs();
	await creating.p;
	await group.closeEditor(saved);
	gate.complete();
	await restoring;
	assert.deepEqual(group.inputs, []);
	assert.deepEqual(fixture.instances, []);
});

function terminalLayoutFixture(owner: DisposableStore, options: {
	readonly recovery?: Promise<void>;
	readonly creationGate?: Promise<void>;
	readonly onCreate?: () => void;
	creationError?: Error;
} = {}): {
	editor: EditorParts;
	commands: CommandService;
	instances: ITerminalInstance[];
	attempts: ICreateTerminalOptions[];
	addInstance: (resource: URI) => ITerminalInstance;
	startRestoringTabs: () => Promise<void>;
} {
	const browser = new JSDOM('<!doctype html><body></body>');
	owner.add(toDisposable(() => browser.window.close()));
	owner.add(installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']));
	const services = owner.add(registerTestComponentServices(createTestEditorServices(undefined, undefined, browser.window.document), browser.window.document));
	const registry = owner.add(new EditorPaneRegistry());
	for (const id of [TerminalEditorInput.ID, 'test.document']) {
		registry.registerEditorPane({
			id, name: 'Terminal layout fixture', canOpen: () => 1,
			create: () => new class extends EditorPane {
				readonly id = id;
				async setInput(): Promise<void> { }
				clearInput(): void { }
				layout(): void { }
				focus(): void { }
			}(id, services.get(IThemeService), services.get(IStorageService)),
		});
	}
	const hosts = owner.add(createDesktopEditorTestServices(services, { registry }, browser.window.document));
	const editor = hosts.editor;
	const parts = new Map<SessionsPartId, Part>(sessionsPartIds.map(id => [id, id === 'editor' ? hosts.area : owner.add(new TestPart(browser.window.document.body, id))]));
	const layout = owner.add(createLayout(browser.window.document.body, parts, { initialDimension: new Dimension(1200, 800) }));
	const contextKeys = owner.add(new ContextKeyService());
	contextKeys.setContext('sessions.desktopCode', true);
	const commands = owner.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	services.registerInstance(ILifecycleService, { willShutdown: false } as ILifecycleService);
	const instances: ITerminalInstance[] = [];
	const attempts: ICreateTerminalOptions[] = [];
	const addInstance = (resource: URI): ITerminalInstance => {
		// Process creation is the boundary; editor membership and toggling use the real owners.
		const instance = { resource, title: 'Shell', profile: { profileId: 'shell', title: 'Shell', isDefault: true } } as ITerminalInstance;
		instances.push(instance);
		return instance;
	};
	const openEditor = async (instance: ITerminalInstance, location?: TerminalEditorLocation): Promise<void> => {
		await editor.openEditor(new TerminalEditorInput(instance.resource!, instance), { pinned: true }, location?.viewColumn === undefined ? undefined : { groupId: location.viewColumn });
	};
	services.registerInstance(ITerminalService, {
		whenConnected: options.recovery ?? Promise.resolve(), instances,
		onDidChangeInstances: Event.None,
		get activeInstance() { return instances.at(-1); },
		setActiveInstance() { },
		async closeTerminal(instance: ITerminalInstance) {
			const index = instances.indexOf(instance);
			if (index >= 0) instances.splice(index, 1);
		},
		async createTerminal(launch: ICreateTerminalOptions = {}): Promise<ITerminalInstance> {
			attempts.push(launch);
			options.onCreate?.();
			await options.creationGate;
			if (options.creationError) {
				throw options.creationError;
			}
			const instance = addInstance(URI.parse(`vscode-terminal:/created/${attempts.length}`));
			if (launch.placeInEditor) {
				try { launch.placeInEditor(instance); }
				catch (error) {
					instances.splice(instances.indexOf(instance), 1);
					throw error;
				}
			} else if (!launch.deferEditorOpen) {
				await openEditor(instance, typeof launch.location === 'object' && 'viewColumn' in launch.location ? launch.location : undefined);
			}
			return instance;
		},
	} as unknown as ITerminalService);
	services.registerInstance(ITerminalEditorService, {
		openEditor,
		getInstanceFromResource: resource => instances.find(instance => instance.resource?.toString() === resource.toString()),
	} as ITerminalEditorService);
	const contribution = owner.add(registerSessionsTerminalContribution(layout, contextKeys, editor));
	return {
		editor, commands, instances, attempts, addInstance,
		startRestoringTabs: () => {
			layout.showPart('editor');
			return services.invokeFunction(contribution.startRestoringTabs);
		},
	};
}

const layoutTestResources = new DisposableStore();
suiteTeardown(() => layoutTestResources.dispose());

function createLayout(container: HTMLElement, parts: ReadonlyMap<SessionsPartId, Part>, options: import('../../browser/desktopWorkbench.js').SessionsWorkbenchLayoutOptions & { storageService?: import('../../../platform/storage/common/storage.js').IStorageService; } = {}): import('../../browser/desktopWorkbench.js').DesktopWorkbenchLayout {
	const ownedStorage = options.storageService ? undefined : layoutTestResources.add(new BrowserStorageService({ ownerWindow: container.ownerDocument.defaultView!, workspaceId: 'sessions', flushInterval: 0, onError: () => { } }));
	const storage = options.storageService ?? ownedStorage!;
	const services = layoutTestResources.add(new InstantiationService());
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IContextKeyService, layoutTestResources.add(new ContextKeyService()));
	const layout = services.createInstance(DesktopWorkbenchLayout, container, options);
	try {
		layout.createWorkbenchLayout(parts);
	} catch (error) {
		layout.dispose();
		throw error;
	}
	return layout;
}
