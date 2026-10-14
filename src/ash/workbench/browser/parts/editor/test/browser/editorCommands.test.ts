import '../../../../../../editor/test/browser/testEditorDom.js';
import { Event } from '../../../../../../base/common/event.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../../base/common/uri.js";
import { ContextKeyService, IContextKeyService } from "../../../../../../platform/contextkey/browser/contextKeyService.js";
import { InstantiationService } from "../../../../../../platform/instantiation/common/instantiationService.js";
import { IQuickInputService } from "../../../../../../platform/quickinput/common/quickInput.js";
import { CommandService } from "../../../../../services/commands/common/commandService.js";
import { TestQuickInputService } from "../../../../../../platform/quickinput/test/browser/testQuickInputService.js";
import { IEditorGroupsService } from "../../../../../services/editor/common/editorGroupsService.js";
import { IEditorPart, type IEditorPart as EditorPartContract } from "../../editorPart.js";
import { registerAction2, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { CloseWorkspaceAction } from '../../../../actions/workspaceActions.js';
import { IHostService } from '../../../../../services/host/browser/host.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../../../services/workspaces/browser/workspaceContextService.js';
import { createTestWorkbenchContextKeysHandler } from '../../../../../test/common/testWorkbenchContextKeys.js';
import { ActiveEditorFirstInGroupContext, ActiveEditorLastInGroupContext, EditorGroupEditorsCountContext, EditorsVisibleContext, MultipleEditorsSelectedInGroupContext } from '../../../../../common/contextkeys.js';
import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { Direction } from '../../../../../../base/browser/ui/grid/grid.js';
import { IHistoryService } from '../../../../../services/history/common/history.js';
import { SubmenuAction } from '../../../../../../base/common/actions.js';
import { IEditorPartsService } from '../../editorParts.js';
import type { EditorIdentifier } from '../../../../../services/editor/common/editorState.js';
import { IPreferencesService, type IOpenSettingsOptions } from '../../../../../services/preferences/common/preferences.js';
import { ConfigureEditorAction } from '../../../../actions/layoutActions.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';

test('Configure Editors menu opens filtered settings and is hidden in the modal editor', async () => {
	await import('../../editor.contribution.js');
	await import('../../../../../contrib/preferences/browser/preferencesActions.js');
	const opened: (IOpenSettingsOptions | undefined)[] = [];
	using services = new InstantiationService();
	services.registerInstance(IPreferencesService, {
		openSettings: async options => { opened.push(options); },
		openUserSettings: async () => assert.fail('Unexpected JSON settings'),
		openGlobalKeybindingSettings: async () => assert.fail('Unexpected keyboard shortcuts'),
	});
	using commands = new CommandService(services);
	using context = new ContextKeyService();
	context.setContext('editorPartModalVisible', false);
	const menus = new MenuService(commands, context);
	const editorActions = () => menus.getMenuActions(MenuId.EditorTitle).flatMap(([, actions]) => actions);
	const configure = editorActions().find(action => action.id === ConfigureEditorAction.ID);
	assert.ok(configure);
	assert.equal(configure.label, 'Configure Editors');
	assert.equal(editorActions().some(action => action.id === 'workbench.action.openSettings'), false);
	await configure.run({ groupId: 'source' });
	assert.deepEqual(opened, [{ query: 'workbench.editor' }]);
	context.setContext('editorPartModalVisible', true);
	assert.equal(editorActions().some(action => action.id === ConfigureEditorAction.ID), false);
	await commands.executeCommand('workbench.action.openSettings');
	assert.deepEqual(opened, [{ query: 'workbench.editor' }, undefined]);

	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsMessages('zh-CN', chinese.bundles);
		assert.deepEqual(new ConfigureEditorAction().desc.title, { original: 'Configure Editors', value: '配置编辑器' });
	} finally {
		resetNlsResolver();
	}
});

test('new window tab menus resolve the clicked tab, multiselection and invalid targets', async () => {
	await import('../../editor.contribution.js');
	const { MoveEditorToNewWindowCommandId, CopyEditorToNewWindowCommandId } = await import('../../editorActions.js');
	const inputs = ['first', 'clicked', 'active'].map(name => ({ resource: URI.file(`/project/${name}.ts`) }));
	const editors = inputs.map((input, index) => ({ input, groupId: 'source', instanceId: `editor-${index}`, paneId: 'test.editor' }));
	const group = { id: 'source', inputs, editors, activeInput: inputs[2], selectedInputs: [inputs[2]] } as unknown as IEditorGroup;
	const opened: { editors: readonly EditorIdentifier[]; mode: string; }[] = [];
	using services = new InstantiationService();
	services.registerInstance(IEditorGroupsService, {
		groups: [group], activeGroup: group, getGroup: (id: string) => id === group.id ? group : undefined,
	} as unknown as IEditorGroupsService);
	services.registerInstance(IEditorPartsService, {
		openEditorsInNewWindow: async (editors, mode) => { opened.push({ editors, mode }); return undefined; },
	} as IEditorPartsService);
	using commands = new CommandService(services);
	using context = new ContextKeyService();
	context.setContext(EditorsVisibleContext.key, true);
	const menus = new MenuService(commands, context);
	const argument = { groupId: group.id, editorIndex: 1 };
	const groups = menus.getMenuActions(MenuId.EditorTitleContext, { arg: argument });
	assert.ok(groups.findIndex(([name]) => name === '7_new_window') > groups.findIndex(([name]) => name === '5_split'));
	const actions = groups.find(([name]) => name === '7_new_window')![1];
	assert.deepEqual(actions.map(action => [action.id, action.label]), [
		[MoveEditorToNewWindowCommandId, 'Move into New Window'],
		[CopyEditorToNewWindowCommandId, 'Copy into New Window'],
	]);
	await actions[0]!.run();
	await actions[1]!.run();
	assert.deepEqual(opened, [
		{ editors: [editors[1]], mode: 'move' },
		{ editors: [editors[1]], mode: 'copy' },
	]);
	Object.assign(group, { selectedInputs: [inputs[0], inputs[1]] });
	await actions[1]!.run();
	assert.deepEqual(opened.at(-1), { editors: editors.slice(0, 2), mode: 'copy' });
	Object.assign(group, { selectedInputs: [inputs[2]] });
	await commands.executeCommand(CopyEditorToNewWindowCommandId);
	assert.deepEqual(opened.at(-1), { editors: [editors[2]], mode: 'copy' });
	await commands.executeCommand(MoveEditorToNewWindowCommandId, { groupId: 'closed', editorIndex: 1 });
	assert.deepEqual(opened.at(-1), { editors: [], mode: 'move' });
});

test('tab close and split menus operate on the clicked group and selected editors', async () => {
	await import('../../editor.contribution.js');
	const { CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, CLOSE_SAVED_EDITORS_COMMAND_ID, CLOSE_EDITORS_IN_GROUP_COMMAND_ID, CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID } = await import('../../editorCommands.js');
	const { CloseAllEditorsCommandId, ReopenClosedEditorCommandId } = await import('../../editorActions.js');
	const inputs = ['sticky', 'clicked', 'dirty', 'saved'].map(name => ({ resource: URI.file(`/project/${name}.ts`) }));
	const closed: unknown[] = [];
	const splits: unknown[] = [];
	let closeAllOptions: unknown;
	let reopened = 0;
	let cancelled = false;
	const group = {
		id: 'clicked-group', inputs, selectedInputs: [inputs[2]], activeInput: inputs[2],
		editors: inputs.map((input, index) => ({ input, index, isSticky: index === 0, isDirty: index === 2 })),
		isSticky: (input: unknown) => input === inputs[0],
		closeEditor: async (input: unknown) => { closed.push(input); return !cancelled; },
	} as unknown as IEditorGroup;
	using services = new InstantiationService();
	services.registerInstance(IEditorGroupsService, { getGroup: id => id === group.id ? group : undefined } as IEditorGroupsService);
	services.registerInstance(IEditorPart, {
		splitEditors: async (id, editors, direction) => { splits.push([id, editors, direction]); },
		closeAllEditors: async options => { closeAllOptions = options; return true; },
	} as EditorPartContract);
	services.registerInstance(IHistoryService, { reopenLastClosedEditor: async () => { reopened++; } } as unknown as IHistoryService);
	using commands = new CommandService(services);
	using context = new ContextKeyService();
	context.setContext(EditorsVisibleContext.key, true);
	context.setContext(EditorGroupEditorsCountContext.key, 4);
	context.setContext(ActiveEditorLastInGroupContext.key, false);
	context.setContext(ActiveEditorFirstInGroupContext.key, false);
	context.setContext(MultipleEditorsSelectedInGroupContext.key, false);
	const menus = new MenuService(commands, context);
	const fileCloseItems = () => menus.getMenuActions(MenuId.MenubarFileMenu).flatMap(([, actions]) => actions).filter(action => [CloseAllEditorsCommandId, 'workbench.action.closeActiveEditor'].includes(action.id)).map(action => ({ id: action.id, enabled: action.enabled }));
	for (const visible of [true, false, true]) {
		context.setContext(EditorsVisibleContext.key, visible);
		assert.deepEqual(fileCloseItems(), [
			{ id: CloseAllEditorsCommandId, enabled: visible },
			{ id: 'workbench.action.closeActiveEditor', enabled: visible },
		]);
	}
	const argument = { groupId: group.id, editorIndex: 1 };
	const close = () => menus.getMenuActions(MenuId.EditorTitleContext, { arg: argument }).find(([name]) => name === '1_close')![1];
	assert.deepEqual(close().map(action => [action.id, action.label]), [
		['workbench.action.closeActiveEditor', 'Close'],
		[CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, 'Close Others'],
		['workbench.action.closeEditorsToTheLeft', 'Close to the Left'],
		[CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, 'Close to the Right'],
		[CLOSE_SAVED_EDITORS_COMMAND_ID, 'Close Saved'],
		[CLOSE_EDITORS_IN_GROUP_COMMAND_ID, 'Close All in Group'],
		[CloseAllEditorsCommandId, 'Close All Tabs'],
	]);
	for (const [id, expected] of [
		[CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, [inputs[2], inputs[3]]],
		['workbench.action.closeEditorsToTheLeft', [inputs[1], inputs[2]]],
		[CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, [inputs[2], inputs[3]]],
		[CLOSE_SAVED_EDITORS_COMMAND_ID, [inputs[1], inputs[3]]],
		[CLOSE_EDITORS_IN_GROUP_COMMAND_ID, inputs.slice(1)],
	] as const) {
		closed.length = 0;
		const action = close().find(action => action.id === id)!;
		if (id === 'workbench.action.closeEditorsToTheLeft') {
			await menus.getMenuActions(MenuId.EditorTitleContext, { arg: { groupId: group.id, editorIndex: 3 } }).flatMap(([, actions]) => actions).find(action => action.id === id)!.run();
		} else {
			await action.run();
		}
		assert.deepEqual(closed, expected);
	}
	await close().find(action => action.id === CloseAllEditorsCommandId)!.run();
	assert.deepEqual(closeAllOptions, { excludeSticky: true });
	await menus.getMenuActions(MenuId.EditorTitleContext, { arg: argument }).flatMap(([, actions]) => actions).find(action => action.id === ReopenClosedEditorCommandId)!.run();
	assert.equal(reopened, 1);
	cancelled = true;
	closed.length = 0;
	await close().find(action => action.id === CLOSE_EDITORS_IN_GROUP_COMMAND_ID)!.run();
	assert.deepEqual(closed, [inputs[1]]);
	closed.length = 0;
	await commands.executeCommand('workbench.action.closeEditorsToTheLeft', { groupId: group.id, editorIndex: 3 });
	assert.deepEqual(closed, [inputs[1]]);
	context.setContext(ActiveEditorFirstInGroupContext.key, true);
	assert.equal(close().find(action => action.id === 'workbench.action.closeEditorsToTheLeft')!.enabled, false);
	context.setContext(ActiveEditorFirstInGroupContext.key, false);
	context.setContext(ActiveEditorLastInGroupContext.key, true);
	assert.equal(close().find(action => action.id === CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID)!.enabled, false);
	context.setContext(ActiveEditorLastInGroupContext.key, false);
	context.setContext(MultipleEditorsSelectedInGroupContext.key, true);
	assert.equal(close().find(action => action.id === CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID)!.enabled, false);
	assert.equal(close().find(action => action.id === 'workbench.action.closeEditorsToTheLeft')!.enabled, false);
	Object.assign(group, { selectedInputs: [inputs[1], inputs[3]] });
	closed.length = 0;
	await commands.executeCommand('workbench.action.closeEditorsToTheLeft', argument);
	assert.deepEqual(closed, []);
	const splitGroup = menus.getMenuActions(MenuId.EditorTitleContext, { arg: argument }).find(([name]) => name === '5_split')![1];
	assert.equal(splitGroup.length, 1);
	const submenu = splitGroup[0];
	assert.ok(submenu instanceof SubmenuAction);
	assert.equal(submenu.label, 'Split');
	const split = submenu.actions;
	assert.deepEqual(split.map(action => action.label), ['Split Up', 'Split Down', 'Split Left', 'Split Right']);
	for (const action of split) await action.run();
	assert.deepEqual(splits, [Direction.Up, Direction.Down, Direction.Left, Direction.Right].map(direction => [group.id, [inputs[1], inputs[3]], direction]));
});

test('Close Workspace delegates an empty window to the host and follows workspace menu state', async () => {
	using registration = registerAction2(CloseWorkspaceAction);
	using workspace = new WorkspaceContextService({ id: 'folder', uri: URI.file('/project') });
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using bindings = createTestWorkbenchContextKeysHandler(contextKeys, { workspaceContextService: workspace, browserLocalFolderSupported: true });
	using commands = new CommandService(services);
	const menus = new MenuService(commands, contextKeys);
	const requests: unknown[] = [];
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IHostService, { hasFocus: true, onDidChangeFocus: Event.None, restart: async () => { }, openWindow: async options => { requests.push(options); }, getScreenshot: async () => undefined });
	const closeMenu = () => menus.getMenuActions(MenuId.MenubarFileMenu).flatMap(([, actions]) => actions).filter(action => action.id === CloseWorkspaceAction.ID).map(action => ({ label: action.label, enabled: action.enabled }));
	assert.deepEqual(closeMenu(), [{ label: 'Close Folder', enabled: true }]);
	await commands.executeCommand(CloseWorkspaceAction.ID);
	assert.deepEqual(requests, [{ forceReuseWindow: true }]);
	workspace.updateWorkspace({ id: 'empty', folders: [] });
	assert.deepEqual(closeMenu(), []);
	workspace.updateWorkspace({ id: 'multi', folders: [], configuration: URI.file('/team.ash-workspace') });
	assert.deepEqual(closeMenu(), [{ label: 'Close Workspace', enabled: true }]);
	workspace.updateWorkspace({ id: 'remote', folders: [{ id: 'remote', uri: URI.parse('ash-remote://ssh+work-server/project'), name: 'project', index: 0 }] });
	await commands.executeCommand(CloseWorkspaceAction.ID);
	assert.deepEqual(requests.at(-1), { forceReuseWindow: true, remoteAuthority: 'ssh+work-server' });
});

test("editor commands close the active tab and reopen it with a chosen editor", async () => {
	const dom = new JSDOM("<!doctype html><body><button>Editor</button></body>");
	const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		Node: dom.window.Node,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		KeyboardEvent: dom.window.KeyboardEvent,
	})) {
		previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}

	try {
		const { CLOSE_EDITOR_COMMAND_ID, REOPEN_WITH_COMMAND_ID } = await import("../../editorCommands.js");
		const activeInput = { resource: URI.file("C:\\project\\main.ts") };
		const otherInput = { resource: URI.file("C:\\project\\other.ts") };
		const additionalInput = { resource: URI.file("C:\\project\\additional.ts") };
		const closedInputs: typeof activeInput[] = [];
		let cancelClose = false;
		const activeGroup = {
			openEditor: async (_input: unknown, options: { preferredEditorId: string; }) => { chosen = options.preferredEditorId; },
			id: "main",
			inputs: [activeInput],
			selectedInputs: [activeInput],
			editors: [{ input: activeInput }],
			activeInput,
			closeEditor: async (input: typeof activeInput) => { closed = input; closedInputs.push(input); return !cancelClose; },
		};
		const otherGroup = {
			id: "other",
			inputs: [otherInput],
			selectedInputs: [otherInput],
			editors: [{ input: otherInput }],
			activeInput: otherInput,
			closeEditor: async (input: typeof activeInput) => { closed = input; return true; },
		};
		const editorTypes = [
			{ id: "ash.editor.binary", name: "Binary Editor" },
			{ id: "stanza.editor.code", name: "Code Editor" },
		];
		let closed: typeof activeInput | undefined;
		let chosen: string | undefined;
		const editorPart = {
			activeInput,
			groups: [activeGroup, otherGroup],
			activeGroup,
			closeEditor: (input: typeof activeInput) => {
				closed = input;
				return Promise.resolve(true);
			},
			getEditorState: () => ({ isModalEditorVisible: false }),
			getEditorPaneChoices: () => editorTypes,
			reopenActiveEditorWith: (id: string) => {
				chosen = id;
				return Promise.resolve(undefined);
			},
		} as unknown as EditorPartContract;

		using services = new InstantiationService();
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IEditorPart, editorPart);
		services.registerInstance(IEditorGroupsService, { groups: [activeGroup, otherGroup], activeGroup, getGroup: (id: string) => [activeGroup, otherGroup].find(group => group.id === id) } as unknown as import("../../../../../services/editor/common/editorGroupsService.js").IEditorGroupsService);
		using quickInput = new TestQuickInputService({ instantiationService: services, container: dom.window.document.body, contextKeyService: contextKeys });
		services.registerInstance(IQuickInputService, quickInput);
		using commands = new CommandService(services);

		await commands.executeCommand(CLOSE_EDITOR_COMMAND_ID);
		assert.equal(closed, activeInput);
		await commands.executeCommand(CLOSE_EDITOR_COMMAND_ID, { groupId: "other", editorIndex: 0, preserveFocus: true });
		assert.equal(closed, otherInput);
		await commands.executeCommand(CLOSE_EDITOR_COMMAND_ID, activeInput.resource);
		assert.equal(closed, activeInput);
		activeGroup.selectedInputs.push(additionalInput);
		await commands.executeCommand(CLOSE_EDITOR_COMMAND_ID);
		assert.deepEqual(closedInputs.slice(-2), [activeInput, additionalInput]);
		cancelClose = true;
		const closeCount = closedInputs.length;
		await commands.executeCommand(CLOSE_EDITOR_COMMAND_ID);
		assert.deepEqual(closedInputs.slice(closeCount), [activeInput]);
		cancelClose = false;
		const reopening = commands.executeCommand(REOPEN_WITH_COMMAND_ID);
		const picker = dom.window.document.querySelector(".ash-quick-pick");
		assert.ok(picker);
		assert.equal(picker.querySelector<HTMLInputElement>("input")?.placeholder, "Select an editor");
		assert.match(picker.textContent ?? "", /Binary Editor/u);
		picker.querySelector<HTMLInputElement>("input")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "Enter",
		}));
		await reopening;
		assert.equal(chosen, "ash.editor.binary");
		assert.equal(dom.window.document.querySelector(".ash-quick-pick"), null);

		editorTypes.pop();
		await commands.executeCommand(REOPEN_WITH_COMMAND_ID);
		assert.equal(dom.window.document.querySelector(".ash-quick-pick"), null);
	} finally {
		for (const [name, descriptor] of previousGlobals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		dom.window.close();
	}
});
