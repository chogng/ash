import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../../base/common/uri.js";
import { ContextKeyService, IContextKeyService } from "../../../../../../platform/contextkey/browser/contextKeyService.js";
import { InstantiationService } from "../../../../../../platform/instantiation/common/instantiationService.js";
import { IQuickInputService } from "../../../../../../platform/quickinput/common/quickInput.js";
import { CommandService } from "../../../../../services/commands/common/commandService.js";
import { WorkbenchQuickInputService } from "../../../../../services/quickinput/browser/quickInputService.js";
import { IEditorGroupsService } from "../../../../../services/editor/common/editorGroupsService.js";
import { IEditorPart, type IEditorPart as EditorPartContract } from "../../editorPart.js";
import { registerAction2, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { CloseWorkspaceAction } from '../../../../actions/workspaceActions.js';
import { IHostService } from '../../../../../services/host/browser/host.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../../../services/workspaces/browser/workspaceContextService.js';
import { createTestWorkbenchContextKeysHandler } from '../../../../../test/common/testWorkbenchContextKeys.js';

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
	services.registerInstance(IHostService, { openWindow: async options => { requests.push(options); } });
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
		using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
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
		await commands.executeCommand(REOPEN_WITH_COMMAND_ID);
		const picker = dom.window.document.querySelector(".ash-quick-pick");
		assert.ok(picker);
		assert.equal(picker.querySelector<HTMLInputElement>("input")?.placeholder, "Select an editor");
		assert.match(picker.textContent ?? "", /Binary Editor/u);
		picker.querySelector<HTMLInputElement>("input")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "Enter",
		}));
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
