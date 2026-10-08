import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { errorHandler } from '../../../../../base/common/errors.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CodeEditorService } from '../../../../services/editor/browser/codeEditorService.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Action2, IMenuService, MenuId, MenusRegistry, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import { MenuService } from "../../../../../platform/actions/common/menuService.js";
import {
	ICommandService,
} from "../../../../../platform/commands/common/commands.js";
import { ContextKeyService, IContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
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
	QuickPickFocus,
	type IQuickPick,
	type IQuickPickItem,
} from "../../../../../platform/quickinput/common/quickInput.js";
import { IQuickAccessController, QuickAccessRegistry } from "../../../../../platform/quickinput/common/quickAccess.js";
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
await import('../../../../../workbench/contrib/quickaccess/browser/quickAccess.contribution.js');
await import('../../../../../workbench/contrib/search/browser/searchQuickAccess.contribution.js');
import { addDisposableListener, h } from "../../../../../base/browser/dom.js";

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

test('Quick Pick item button fires without accepting its row', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	installDomGlobals(dom);
	const list = new QuickInputList(dom.window.document.body);
	const triggered: string[] = [];
	const accepted: string[] = [];
	list.onDidTriggerItemButton(({ item, button }) => triggered.push(`${item.label}:${button.id}`));
	list.onDidAccept(item => accepted.push(item.label));
	list.items = [{ label: 'main.ts', className: 'ash-editor-quick-pick-item dirty', buttons: [{ id: 'close', label: 'Close Editor' }] }];
	const button = list.element.querySelector<HTMLButtonElement>('.ash-quick-pick-row-action');
	assert.ok(button);
	assert.equal(button.getAttribute('aria-label'), 'Close Editor');
	button.click();
	assert.deepEqual(triggered, ['main.ts:close']);
	assert.deepEqual(accepted, []);
	assert.equal(button.closest('.ash-editor-quick-pick-item.dirty') !== null, true);
	list.dispose();
	dom.window.close();
});

test('QuickInputList skips section headings and reports keyboard modifiers during acceptance', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	installDomGlobals(dom);
	const list = new QuickInputList(dom.window.document.body);
	const accepted: unknown[] = [];
	list.onDidAccept(item => accepted.push({ label: item.label, ...list.keyMods }));
	list.items = [{ type: 'separator', label: 'Recently opened' }, { label: 'main.ts' }];
	list.focus(QuickPickFocus.First);
	list.acceptActive(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
	list.acceptActive(new dom.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
	list.acceptActive(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
	assert.deepEqual(accepted, [
		{ label: 'main.ts', ctrlCmd: true, alt: false, shift: false },
		{ label: 'main.ts', ctrlCmd: true, alt: false, shift: false },
		{ label: 'main.ts', ctrlCmd: false, alt: false, shift: false },
	]);
	list.dispose();
	dom.window.close();
});

test("QuickInputList owns filtering, looping focus, and acceptance", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	installDomGlobals(dom);
	const list = new QuickInputList<{ label: string; }>(
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
	list.focus(QuickPickFocus.Previous);
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

	const services = new InstantiationService();
	services.registerSingleton(IDialogService, () => new DialogService());
	services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
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
	input.value = ">palette target";
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

test('Command Palette releases its provider before an accepted command disposes the captured editor', async () => {
	const dom = new JSDOM('<!doctype html><body><button>Editor</button></body>');
	installDomGlobals(dom);
	const unexpectedErrors: unknown[] = [];
	const previousErrorHandler = errorHandler.getUnexpectedErrorHandler();
	errorHandler.setUnexpectedErrorHandler(error => unexpectedErrors.push(error));
	try {
		using services = new InstantiationService();
		services.registerSingleton(IDialogService, () => new DialogService());
		services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		using commands = new CommandService(services);
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IMenuService, new MenuService(commands, contextKeys));
		using keybindingsChanged = new Emitter<void>();
		services.registerInstance(IKeybindingService, { ...emptyKeybindingService(), onDidUpdateKeybindings: keybindingsChanged.event });
		using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		services.registerInstance(IQuickInputService, quickInput);
		using quickAccess = services.createInstance(QuickAccessController);
		services.registerInstance(IQuickAccessController, quickAccess);
		let disposed = false;
		let executions = 0;
		const editor = {
			getId: () => 'test.palette.disposal', hasTextFocus: () => true, hasWidgetFocus: () => false,
			getSupportedActions: () => { assert.equal(disposed, false, 'Hidden provider queried a disposed editor'); return []; },
		} as unknown as ICodeEditor;
		const editors = services.get(ICodeEditorService);
		editors.addCodeEditor(editor);
		class DisposeEditorAction extends Action2 {
			constructor() { super({ id: 'test.palette.disposeEditor', title: 'Dispose Captured Editor', f1: true }); }
			override run(): void {
				executions++;
				disposed = true;
				editors.removeCodeEditor(editor);
				keybindingsChanged.fire();
			}
		}
		using actionRegistration = registerAction2(DisposeEditorAction);
		quickAccess.show('>Dispose Captured Editor');
		const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
		assert.ok(input);
		input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
		await Promise.resolve();
		assert.deepEqual({ executions, disposed, picker: dom.window.document.querySelector('.ash-quick-pick'), errors: unexpectedErrors }, {
			executions: 1, disposed: true, picker: null, errors: [],
		});
	} finally {
		errorHandler.setUnexpectedErrorHandler(previousErrorHandler);
		dom.window.close();
	}
});

test('Quick Access preserves hide delivery and a new session opened before old cleanup', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	installDomGlobals(dom);
	try {
		using services = new InstantiationService();
		using contextKeys = new ContextKeyService();
		using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		services.registerInstance(IQuickInputService, quickInput);
		using quickAccess = services.createInstance(QuickAccessController);
		const runs: { picker: IQuickPick<IQuickPickItem>; signal: AbortSignal; disposed: number; complete(): Promise<void>; }[] = [];
		class PendingProvider {
			provide(picker: IQuickPick<IQuickPickItem>, _prefix: string, signal: AbortSignal) {
				const generation = runs.length + 1;
				picker.items = [{ label: `Current ${generation}` }];
				let resolve!: () => void;
				const completed = new Promise<void>(done => { resolve = done; }).then(() => {
					if (!signal.aborted) picker.items = [{ label: `Completed ${generation}` }];
				});
				const run = { picker, signal, disposed: 0, complete: () => { resolve(); return completed; } };
				runs.push(run);
				return toDisposable(() => { run.disposed++; });
			}
		}
		using registration = QuickAccessRegistry.register({ prefix: 'test-lifetime:', placeholder: 'Lifetime', helpLabel: 'Lifetime', ctor: PendingProvider });
		quickAccess.show('test-lifetime:');
		const first = runs[0]!;
		let hideEvents = 0;
		using hideListener = first.picker.onDidHide(() => { hideEvents++; });
		using visibilityListener = quickAccess.onDidChangeVisibility(visible => {
			if (!visible && runs.length === 1) quickAccess.show('test-lifetime:');
		});
		first.picker.hide();
		first.picker.hide();
		assert.deepEqual({ hidden: hideEvents, aborted: first.signal.aborted, disposed: first.disposed, generations: runs.length }, {
			hidden: 1, aborted: true, disposed: 1, generations: 2,
		});
		const second = runs[1]!;
		await first.complete();
		first.picker.dispose();
		assert.deepEqual({ items: second.picker.items.map(item => item.label), aborted: second.signal.aborted, disposed: second.disposed, visible: contextKeys.getValue(InQuickInputContext.key) }, {
			items: ['Current 2'], aborted: false, disposed: 0, visible: true,
		});
		await second.complete();
		assert.deepEqual(second.picker.items.map(item => item.label), ['Completed 2']);
		quickAccess.dispose();
		quickAccess.dispose();
		await Promise.resolve();
		assert.deepEqual({ disposed: runs.map(run => run.disposed), aborted: runs.map(run => run.signal.aborted), picker: dom.window.document.querySelector('.ash-quick-pick') }, {
			disposed: [1, 1], aborted: [true, true], picker: null,
		});
	} finally {
		dom.window.close();
	}
});

test('Quick Access cancels old provider results when switching modes in the same picker', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	installDomGlobals(dom);
	try {
		using services = new InstantiationService();
		using contextKeys = new ContextKeyService();
		using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		services.registerInstance(IQuickInputService, quickInput);
		using quickAccess = services.createInstance(QuickAccessController);
		let oldSignal: AbortSignal | undefined;
		let oldPicker: IQuickPick<IQuickPickItem> | undefined;
		let newPicker: IQuickPick<IQuickPickItem> | undefined;
		let resolve!: () => void;
		let completed: Promise<void> | undefined;
		let oldDisposed = 0;
		let newDisposed = 0;
		class OldProvider {
			provide(picker: IQuickPick<IQuickPickItem>, _prefix: string, signal: AbortSignal) {
				oldSignal = signal;
				oldPicker = picker;
				completed = new Promise<void>(done => { resolve = done; }).then(() => {
					if (!signal.aborted) picker.items = [{ label: 'Stale result' }];
				});
				return toDisposable(() => { oldDisposed++; });
			}
		}
		class NewProvider {
			provide(picker: IQuickPick<IQuickPickItem>) {
				newPicker = picker;
				picker.items = [{ label: 'Current result' }];
				return toDisposable(() => { newDisposed++; });
			}
		}
		using oldRegistration = QuickAccessRegistry.register({ prefix: 'test-old:', placeholder: 'Old', helpLabel: 'Old', ctor: OldProvider });
		using newRegistration = QuickAccessRegistry.register({ prefix: 'test-new:', placeholder: 'New', helpLabel: 'New', ctor: NewProvider });
		quickAccess.show('test-old:');
		quickAccess.show('test-new:');
		assert.ok(newPicker);
		assert.equal(newPicker, oldPicker);
		resolve();
		await completed;
		assert.deepEqual({ aborted: oldSignal?.aborted, disposed: oldDisposed, items: newPicker.items.map(item => item.label) }, {
			aborted: true, disposed: 1, items: ['Current result'],
		});
		newPicker.hide();
		newPicker.hide();
		quickAccess.dispose();
		quickAccess.dispose();
		await Promise.resolve();
		assert.deepEqual({ oldDisposed, newDisposed, picker: dom.window.document.querySelector('.ash-quick-pick') }, { oldDisposed: 1, newDisposed: 1, picker: null });
	} finally {
		dom.window.close();
	}
});

test('Quick Access switches search modes in one picker and restores focus on close', () => {
	const dom = new JSDOM('<!doctype html><body><button>Search</button></body>');
	installDomGlobals(dom);
	{
		using services = new InstantiationService();
		services.registerSingleton(IDialogService, () => new DialogService());
		services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
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
		quickAccess.show('>');
		const picker = dom.window.document.querySelector('.ash-quick-pick');
		const input = picker?.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
		assert.ok(picker);
		assert.ok(input);
		assert.equal(input.placeholder, 'Type the name of a command to run');
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

test('Quick Input preserves viewport intent across repeated focus restoration and disposal', () => {
	const dom = new JSDOM('<!doctype html><body><button>Editor</button><button>Other editor</button></body>');
	installDomGlobals(dom);
	try {
		using contextKeys = new ContextKeyService();
		using service = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		const [editor, otherEditor] = dom.window.document.querySelectorAll('button');
		const originalFocus = editor.focus;
		const focusCalls: (FocusOptions | undefined)[] = [];
		editor.focus = function (options?: FocusOptions): void {
			focusCalls.push(options);
			originalFocus.call(this, options);
		};
		try {
			using picker = service.createQuickPick();
			picker.items = [{ label: 'Keep position' }];
			for (const close of ['hide', 'hide', 'Escape']) {
				editor.focus();
				focusCalls.length = 0;
				picker.show();
				if (close === 'Escape') {
					const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
					assert.ok(input);
					input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
				} else {
					picker.hide();
				}
				picker.hide();
				assert.deepEqual({ focus: dom.window.document.activeElement, calls: [...focusCalls], visible: contextKeys.getValue(InQuickInputContext.key) }, { focus: editor, calls: [{ preventScroll: true }], visible: false });
			}
			picker.show();
			otherEditor.focus();
			focusCalls.length = 0;
			picker.hide();
			assert.deepEqual({ focus: dom.window.document.activeElement, calls: [...focusCalls] }, { focus: otherEditor, calls: [] });
			editor.focus();
			focusCalls.length = 0;
			picker.show();
			picker.dispose();
			picker.dispose();
			assert.deepEqual({ focus: dom.window.document.activeElement, calls: [...focusCalls] }, { focus: editor, calls: [{ preventScroll: true }] });
			editor.focus();
			focusCalls.length = 0;
			service.createQuickPick().show();
			service.dispose();
			service.dispose();
			assert.deepEqual({ focus: dom.window.document.activeElement, calls: [...focusCalls], host: dom.window.document.querySelector('.ash-quick-input-host') }, { focus: editor, calls: [{ preventScroll: true }], host: null });
		} finally {
			delete (editor as Partial<HTMLButtonElement>).focus;
		}
	} finally {
		dom.window.close();
	}
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

	const renamed = service.input({ title: 'Rename', value: 'old.ts' });
	const renameInput = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
	assert.equal(renameInput?.value, 'old.ts');
	renameInput?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
	assert.equal(await renamed, 'old.ts');

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

test('Quick Input keeps clicks inside the picker and passes outside clicks to the workbench', () => {
	const dom = new JSDOM('<!doctype html><body><button>Editor</button><button>Workbench action</button></body>');
	installDomGlobals(dom);
	{
		using contextKeys = new ContextKeyService();
		using service = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		const [editor, action] = dom.window.document.querySelectorAll('button');
		const picker = service.createQuickPick();
		let clicks = 0;
		using clickListener = addDisposableListener(action, 'click', () => { clicks++; });
		editor.focus();
		picker.show();
		const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input');
		assert.ok(input);
		input.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
		assert.equal(contextKeys.getValue(InQuickInputContext.key), true);
		action.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
		action.click();
		assert.deepEqual({ clicks, pickerVisible: contextKeys.getValue(InQuickInputContext.key) }, { clicks: 1, pickerVisible: false });
	}
	dom.window.close();
});

function emptyKeybindingService(): KeybindingService {
	return {
		inChordMode: false,
		onDidUpdateKeybindings: () => ({
			dispose() { },
			[Symbol.dispose]() { },
		}),
		resolveKeybinding() {
			throw new Error("Not needed by Command Palette test");
		},
		registerSchemaContribution: () => Disposable.None,
		getKeybindings: () => [],
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
