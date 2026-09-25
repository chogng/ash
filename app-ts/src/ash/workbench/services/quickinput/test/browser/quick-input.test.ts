import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Action2, IMenuService, MenuId, MenusRegistry, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import { MenuService } from "../../../../../platform/actions/common/menuService.js";
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
import { IQuickAccessController } from "../../../../../platform/quickinput/common/quickAccess.js";
import { QuickAccessController } from "../../../../../platform/quickinput/browser/quickAccess.js";
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import {
	CommandService,
} from "../../../../../workbench/services/commands/common/commandService.js";
import {
	WorkbenchQuickInputService,
} from "../../../../../workbench/services/quickinput/browser/quickInputService.js";
import { builtinLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import {
	InQuickInputContext,
	ShowAllCommandsCommandId,
} from "../../../../../workbench/browser/quickaccess.js";
await import("../../../../../workbench/contrib/quickaccess/browser/commandsQuickAccess.js");
await import("../../../../../workbench/contrib/quickaccess/browser/helpQuickAccess.js");
await import('../../../../../workbench/contrib/quickaccess/browser/workspaceSymbolsQuickAccess.js');
import { h } from "../../../../../base/browser/dom.js";

test("Show All Commands is not duplicated in the titlebar action menu", () => {
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
	const quickAccess = services.createInstance(QuickAccessController);
	services.registerInstance(IQuickAccessController, quickAccess);
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
	quickAccess.dispose();
	commands.dispose();
	contextKeys.dispose();
	dom.window.close();
});

test('Quick Access switches search modes in one picker and restores focus on close', () => {
	const dom = new JSDOM('<!doctype html><body><button>Search</button></body>');
	installDomGlobals(dom);
	{
		using services = new ServiceContainer();
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		using commands = new CommandService(services);
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IMenuService, new MenuService(commands, contextKeys));
		services.registerInstance(IKeybindingService, emptyKeybindingService());
		using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		services.registerInstance(IQuickInputService, quickInput);
		using quickAccess = services.createInstance(QuickAccessController);
		services.registerInstance(IQuickAccessController, quickAccess);
		const button = dom.window.document.querySelector('button')!;
		button.focus();
		quickAccess.show();
		const picker = dom.window.document.querySelector('.ash-quick-pick');
		const input = picker?.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
		assert.ok(picker);
		assert.ok(input);
		assert.equal(input.placeholder, 'Search commands (type >, @, or ? for modes)');
		input.value = '?';
		input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		assert.equal(dom.window.document.querySelector('.ash-quick-pick'), picker);
		assert.equal(input.placeholder, 'Select a search mode');
		const commandMode = [...picker.querySelectorAll<HTMLElement>('.ash-quick-pick-row-label')]
			.find(label => label.textContent === '> Commands');
		assert.ok(commandMode);
		commandMode.click();
		assert.equal(dom.window.document.querySelector('.ash-quick-pick'), picker);
		assert.equal(input.value, '>');
		assert.equal(input.placeholder, 'Type the name of a command to run');
		assert.equal(input.selectionStart, 1);
		assert.equal(input.selectionEnd, 1);
		quickAccess.show('>foo');
		assert.equal(input.value, '>foo');
		assert.equal(input.selectionStart, 1);
		assert.equal(input.selectionEnd, 4);
		input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
		assert.equal(dom.window.document.querySelector('.ash-quick-pick'), null);
		assert.equal(dom.window.document.activeElement, button);
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
		assert.ok(chinese);
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		try {
			quickAccess.show('>');
			const localizedPicker = dom.window.document.querySelector('.ash-quick-pick');
			const localizedInput = localizedPicker?.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
			assert.ok(localizedPicker);
			assert.ok(localizedInput);
			assert.equal(localizedInput.placeholder, '输入要运行的命令名称');
			assert.equal(localizedInput.getAttribute('aria-label'), '输入要运行的命令名称');
			assert.equal([...localizedPicker.querySelectorAll<HTMLElement>('.ash-quick-pick-row-label')].some(label => label.textContent === '转到工作区中的符号'), true);
			quickAccess.show('?');
			assert.equal(localizedInput.placeholder, '选择搜索模式');
			const labels = [...localizedPicker.querySelectorAll<HTMLElement>('.ash-quick-pick-row-label')].map(label => label.textContent);
			assert.deepEqual(labels, ['> 命令', '@ 工作区中的符号']);
			quickAccess.show('?missing');
			assert.equal(localizedPicker.querySelector('.ash-quick-pick-empty')?.textContent, '没有匹配结果');
			assert.equal(localizedPicker.querySelector('.ash-quick-pick-list-items')?.getAttribute('aria-label'), '快速选择结果');
			localizedInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
			assert.equal(dom.window.document.querySelector('.ash-quick-pick'), null);
			assert.equal(dom.window.document.activeElement, button);
		} finally {
			resetNlsResolver();
		}
	}
	dom.window.close();
});

test('Quick Input replaces a visible picker and releases it with its host', () => {
	const dom = new JSDOM('<!doctype html><body><button>Editor</button></body>');
	installDomGlobals(dom);
	using contextKeys = new ContextKeyService();
	const service = new WorkbenchQuickInputService({
		container: dom.window.document.body,
		contextKeyService: contextKeys,
	});
	try {
		const button = dom.window.document.querySelector('button')!;
		button.focus();
		const first = service.createQuickPick();
		let firstHidden = 0;
		first.onDidHide(() => { firstHidden++; });
		first.items = [{ label: 'First' }];
		first.show();
		const second = service.createQuickPick();
		const values: string[] = [];
		second.onDidChangeValue(value => values.push(value));
		second.items = [{ label: 'Second' }, { label: 'Other' }];
		second.value = 'second';
		second.value = 'second';
		second.show();
		assert.equal(firstHidden, 1);
		assert.deepEqual(values, ['second']);
		assert.deepEqual([...dom.window.document.querySelectorAll('.ash-quick-pick-row-label')].map(item => item.textContent), ['Second']);
		assert.equal(contextKeys.getValue(InQuickInputContext.key), true);
		let secondHidden = 0;
		second.onDidHide(() => { secondHidden++; });
		service.dispose();
		assert.equal(secondHidden, 1);
		assert.equal(contextKeys.getValue(InQuickInputContext.key), false);
		assert.equal(dom.window.document.querySelector('.ash-quick-input-host'), null);
		assert.equal(dom.window.document.activeElement, button);
	} finally {
		service.dispose();
		dom.window.close();
	}
});

test('Quick Input masks a password, validates it, clears it, and restores focus', async () => {
	const dom = new JSDOM('<!doctype html><body><button>Editor</button></body>');
	installDomGlobals(dom);
	using contextKeys = new ContextKeyService();
	using service = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
	const editor = dom.window.document.querySelector('button')!;
	editor.focus();

	const accepted = service.input({ title: 'Provider API key', password: true, validateInput: async value => value.trim() ? undefined : 'Enter a key' });
	const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
	assert.ok(input);
	assert.equal(input.type, 'password');
	assert.equal(input.getAttribute('aria-label'), 'Provider API key');
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
	await Promise.resolve();
	assert.equal(input.getAttribute('aria-invalid'), 'true');
	assert.equal(dom.window.document.querySelector('.ash-input-box-message')?.textContent, 'Enter a key');
	input.value = 'test-secret';
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
	assert.equal(await accepted, 'test-secret');
	assert.equal(input.value, '');
	assert.equal(dom.window.document.querySelector('.ash-quick-pick'), null);
	assert.equal(dom.window.document.activeElement, editor);

	const cancelled = service.input({ title: 'Another key', password: true });
	const next = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
	assert.ok(next);
	next.value = 'discard-me';
	next.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
	assert.equal(await cancelled, undefined);
	assert.equal(next.value, '');

	const abandoned = service.input({ title: 'Unfinished key', password: true });
	const unfinished = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
	assert.ok(unfinished);
	unfinished.value = 'discard-on-dispose';
	service.dispose();
	assert.equal(await abandoned, undefined);
	assert.equal(unfinished.value, '');
	dom.window.close();
});

test('Quick Pick labels its input and reports focus leaving the picker', async () => {
	const dom = new JSDOM('<!doctype html><body><button>Editor</button><button>Other editor</button></body>');
	installDomGlobals(dom);
	using contextKeys = new ContextKeyService();
	using service = new WorkbenchQuickInputService({
		container: dom.window.document.body,
		contextKeyService: contextKeys,
	});
	const button = dom.window.document.querySelector('button')!;
	const nextButton = dom.window.document.querySelectorAll('button')[1]!;
	try {
		button.focus();
		using picker = service.createQuickPick();
		picker.ariaLabel = 'Go to Symbol';
		picker.items = [{ label: 'main' }];
		let blurs = 0;
		using listener = picker.onDidBlur(() => blurs++);
		picker.show();
		assert.equal(dom.window.document.querySelector('.ash-quick-pick')?.getAttribute('aria-label'), 'Go to Symbol');
		assert.equal(dom.window.document.querySelector('.ash-quick-pick-input input')?.getAttribute('aria-label'), 'Go to Symbol');
		nextButton.focus();
		await Promise.resolve();
		assert.equal(blurs, 1);
		picker.hide();
		assert.equal(dom.window.document.activeElement, nextButton);
	} finally {
		service.dispose();
		dom.window.close();
	}
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
