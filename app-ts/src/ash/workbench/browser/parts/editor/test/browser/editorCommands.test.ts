import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../../base/common/uri.js";
import { ContextKeyService, IContextKeyService } from "../../../../../../platform/contextkey/browser/contextKeyService.js";
import { ServiceContainer } from "../../../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService } from "../../../../../../platform/quickinput/common/quickInput.js";
import { CommandService } from "../../../../../services/commands/common/commandService.js";
import { WorkbenchQuickInputService } from "../../../../../services/quickinput/browser/quickInputService.js";
import { IEditorPart, type IEditorPart as EditorPartContract } from "../../editorPart.js";

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
		const activeGroup = {
			id: "main",
			inputs: [activeInput],
			selectedInputs: [activeInput],
			editors: [{ input: activeInput }],
			activeInput,
			closeEditor: async (input: typeof activeInput) => { closed = input; closedInputs.push(input); return true; },
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
			getEditorPaneChoices: () => editorTypes,
			reopenActiveEditorWith: (id: string) => {
				chosen = id;
				return Promise.resolve(undefined);
			},
		} as unknown as EditorPartContract;

		using services = new ServiceContainer();
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IEditorPart, editorPart);
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
