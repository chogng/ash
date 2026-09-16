import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Action2, MenuId, MenusRegistry, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import {
	IMenuService,
	MenuService,
} from "../../../../../platform/actions/common/menuService.js";
import {
	ICommandService,
} from "../../../../../platform/commands/common/commands.js";
import { ContextKeyService, IContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import {
	ServiceContainer,
} from "../../../../../platform/instantiation/common/instantiation.js";
import {
	IKeybindingService,
	type IKeybindingService as KeybindingService,
} from "../../../../../platform/keybinding/common/keybinding.js";
import {
	filterQuickPickItems,
	QuickInputList,
} from "../../../../../platform/quickinput/browser/quickInputList.js";
import {
	IQuickInputService,
} from "../../../../../platform/quickinput/common/quickInput.js";
import {
	CommandService,
} from "../../../../../workbench/services/commands/common/commandService.js";
import {
	WorkbenchQuickInputService,
} from "../../../../../workbench/services/quickinput/browser/quickInputService.js";
import {
	InQuickInputContext,
} from "../../../../../workbench/browser/quickaccess.js";
import {
	ShowAllCommandsCommandId,
} from "../../../../../workbench/contrib/quickaccess/browser/commandsQuickAccess.js";
import { h } from "../../../../../base/browser/dom.js";

test("Show All Commands is not exposed in the titlebar", () => {
	const titlebarCommandIds = MenusRegistry.getMenuItems(MenuId.TitleBar)
		.flatMap((item) => "command" in item ? [item.command.id] : []);

	assert.equal(titlebarCommandIds.includes(ShowAllCommandsCommandId), false);
});

test("Quick Pick filtering matches ordered characters and favors labels", () => {
	const items = [
		{ label: "Open Folder", description: "workbench.openFolder" },
		{ label: "Format Document", description: "editor.formatDocument" },
		{ label: "Focus Sidebar", description: "workbench.focusSidebar" },
	];

	assert.deepEqual(
		filterQuickPickItems(items, "open f").map((item) => item.label),
		["Open Folder"],
	);
	assert.deepEqual(
		filterQuickPickItems(items, "format").map((item) => item.label),
		["Format Document"],
	);
	assert.deepEqual(filterQuickPickItems(items, "missing"), []);
});

test("QuickInputList owns filtering, looping focus, and acceptance", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	installDomGlobals(dom);
	const list = new QuickInputList<{ label: string }>(
		dom.window.document.body,
	);
	dom.window.document.body.append(list.element);
	const activeLabels: (string | undefined)[] = [];
	const acceptedLabels: string[] = [];
	const activeListener = list.onDidChangeActive(({ item }) => {
		activeLabels.push(item?.label);
	});
	const acceptListener = list.onDidAccept((item) => {
		acceptedLabels.push(item.label);
	});

	list.items = [
		{ label: "First" },
		{ label: "Second" },
		{ label: "Third" },
	];
	assert.equal(list.activeItem?.label, "First");
	list.focusPrevious();
	assert.equal(list.activeItem?.label, "Third");
	list.acceptActive();
	assert.deepEqual(acceptedLabels, ["Third"]);

	list.filter("second");
	assert.deepEqual(
		list.visibleItems.map((item) => item.label),
		["Second"],
	);
	assert.equal(list.activeItem?.label, "Second");
	list.filter("missing");
	assert.equal(list.activeItem, undefined);
	assert.equal(
		list.element.querySelector(".ash-quick-pick-empty")?.textContent,
		"No matching results",
	);
	assert.equal(activeLabels.at(-1), undefined);

	acceptListener.dispose();
	activeListener.dispose();
	list.dispose();
	dom.window.close();
});

test("Command Palette filters, executes, closes, and restores focus", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	installDomGlobals(dom);
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	const focusTarget = h(dom.window.document, "button");
	focusTarget.textContent = "Restore focus";
	container.append(focusTarget);
	focusTarget.focus();

	const services = new ServiceContainer();
	const contextKeys = new ContextKeyService();
	services.registerInstance(IContextKeyService, contextKeys);
	const commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	const menus = new MenuService(commands, contextKeys);
	services.registerInstance(IMenuService, menus);
	const quickInput = new WorkbenchQuickInputService({
		container,
		contextKeyService: contextKeys,
	});
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IKeybindingService, emptyKeybindingService());

	let executions = 0;
	class PaletteTargetAction extends Action2 {
		constructor() {
			super({
				id: "test.quickInput.target",
				title: "Run Palette Target",
				f1: true,
			});
		}

		override run(): void {
			executions += 1;
		}
	}
	using actionRegistration = registerAction2(PaletteTargetAction);

	await commands.executeCommand(ShowAllCommandsCommandId);
	assert.equal(contextKeys.getValue(InQuickInputContext.key), true);
	const input = container.querySelector<HTMLInputElement>(
		".ash-quick-pick-input input",
	);
	assert.ok(input);
	input.value = "palette target";
	input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	assert.deepEqual(
		[...container.querySelectorAll(".ash-quick-pick-row-label")]
			.map((label) => label.textContent),
		["Run Palette Target"],
	);

	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	await Promise.resolve();

	assert.equal(executions, 1);
	assert.equal(contextKeys.getValue(InQuickInputContext.key), false);
	assert.equal(
		container.querySelector(".ash-quick-pick"),
		null,
	);
	assert.equal(dom.window.document.activeElement, focusTarget);

	quickInput.dispose();
	commands.dispose();
	contextKeys.dispose();
	dom.window.close();
});

function emptyKeybindingService(): KeybindingService {
	return {
		inChordMode: false,
		onDidUpdateKeybindings: () => ({
			dispose() {},
			[Symbol.dispose]() {},
		}),
		resolveKeybinding() {
			throw new Error("Not needed by Command Palette test");
		},
		resolveUserBinding: () => undefined,
		lookupKeybindings: () => [],
		lookupKeybinding: () => undefined,
	};
}

function installDomGlobals(dom: JSDOM): void {
	for (const [name, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		Node: dom.window.Node,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		MouseEvent: dom.window.MouseEvent,
		KeyboardEvent: dom.window.KeyboardEvent,
		navigator: dom.window.navigator,
	})) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
		});
	}
}
