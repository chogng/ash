import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../../../../base/common/event.js";
import { URI } from "../../../../../../base/common/uri.js";
import { Range } from "../../../../../../editor/common/core/range.js";
import type { LanguageDocumentSymbol } from "../../../../../../editor/common/languages.js";
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from "../../../../../../nls.js";
import { IContextKeyService, ContextKeyService } from "../../../../../../platform/contextkey/browser/contextKeyService.js";
import { ServiceContainer } from "../../../../../../platform/instantiation/common/instantiation.js";
import { QuickAccessController } from "../../../../../../platform/quickinput/browser/quickAccess.js";
import { IQuickAccessController } from "../../../../../../platform/quickinput/common/quickAccess.js";
import { IQuickInputService } from "../../../../../../platform/quickinput/common/quickInput.js";
import { CommandService } from "../../../../../services/commands/common/commandService.js";
import { builtinLanguagePackCatalogs } from "../../../../../services/localization/common/localizationCatalogs.js";
import { WorkbenchQuickInputService } from "../../../../../services/quickinput/browser/quickInputService.js";
import { IEditorPart, type IEditorPart as EditorPartContract } from "../../editorPart.js";
import { AllEditorsByMostRecentlyUsedQuickAccess } from "../../editorQuickAccess.js";
import { BreadcrumbsSymbolPicker } from "../../breadcrumbsPicker.js";
import type { EditorPartChangeEvent } from "../../../../../services/editor/common/editorState.js";

test("Show All Editors opens the MRU quick access mode and activates the chosen editor", async () => {
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
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === "zh-CN");
		assert.ok(chinese);
		setNlsResolver((bundle, key, fallback, parameters) =>
			formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		await import("../../editor.contribution.js");
		const { ShowAllEditorsCommandId } = await import("../../editorActions.js");
		const selected = { groupId: "group-1", instanceId: "editor-1", paneId: "pane-1", input: { resource: URI.file("C:\\project\\main.ts") } };
		const changes = new Emitter<EditorPartChangeEvent>();
		let activated: string | undefined;
		let focused = false;
		const editorPart = {
			editorsMru: [selected],
			groups: [{ id: selected.groupId, editors: [{ instanceId: selected.instanceId, isDirty: false }] }],
			onDidChangeEditors: changes.event,
			activateEditorIdentifier: (editor: typeof selected) => { activated = editor.instanceId; },
			focus: () => { focused = true; },
		} as unknown as EditorPartContract;

		using services = new ServiceContainer();
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IEditorPart, editorPart);
		using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		services.registerInstance(IQuickInputService, quickInput);
		using quickAccess = services.createInstance(QuickAccessController);
		services.registerInstance(IQuickAccessController, quickAccess);
		using commands = new CommandService(services);
		const focusTarget = dom.window.document.querySelector("button");
		assert.ok(focusTarget);
		focusTarget.focus();

		await commands.executeCommand(ShowAllEditorsCommandId);
		const picker = dom.window.document.querySelector(".ash-quick-pick");
		const input = picker?.querySelector<HTMLInputElement>(".ash-quick-pick-input input");
		assert.ok(picker);
		assert.ok(input);
		assert.equal(input.value, AllEditorsByMostRecentlyUsedQuickAccess.PREFIX);
		assert.equal(input.placeholder, "选择一个已打开的编辑器");
		assert.equal(picker.querySelector(".ash-quick-pick-row-label")?.textContent, "main.ts");
		assert.match(picker.textContent ?? "", /第 1 组/u);
		input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));

		assert.equal(activated, "editor-1");
		assert.equal(focused, true);
		assert.equal(dom.window.document.querySelector(".ash-quick-pick"), null);
		assert.equal(dom.window.document.activeElement, focusTarget);
		changes.dispose();
	} finally {
		resetNlsResolver();
		for (const [name, descriptor] of previousGlobals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		dom.window.close();
	}
});

test("breadcrumb symbol picker reveals a nested outline item", () => {
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
		using contextKeys = new ContextKeyService();
		using quickInput = new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: contextKeys });
		const outerRange = new Range(1, 1, 3, 1);
		const innerRange = new Range(2, 1, 2, 10);
		const inner: LanguageDocumentSymbol = { name: "Beta", kind: "method", range: innerRange, selectionRange: innerRange };
		const outer: LanguageDocumentSymbol = { name: "Alpha", kind: "class", range: outerRange, selectionRange: outerRange, children: [inner] };
		let revealed: Range | undefined;
		const picker = new BreadcrumbsSymbolPicker([outer], inner, range => { revealed = range; }, quickInput);
		picker.show();
		const input = dom.window.document.querySelector<HTMLInputElement>(".ash-quick-pick-input input");
		assert.ok(input);
		assert.match(input.placeholder, /Beta/u);
		input.value = "Beta";
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		assert.equal(dom.window.document.querySelectorAll(".ash-quick-pick-row-label").length, 1);
		input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
		assert.deepEqual(revealed, innerRange);
		assert.equal(dom.window.document.querySelector(".ash-quick-pick"), null);
	} finally {
		for (const [name, descriptor] of previousGlobals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		dom.window.close();
	}
});
