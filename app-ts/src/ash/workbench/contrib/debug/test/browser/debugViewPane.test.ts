import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DeferredPromise } from "../../../../../base/common/async.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { ServiceCollection } from "../../../../../platform/instantiation/common/serviceCollection.js";
import { Event as CommonEvent } from "../../../../../base/common/event.js";
import { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from "../../../../../nls.js";
import { builtinLanguagePackCatalogs } from "../../../../services/localization/common/localizationCatalogs.js";
import { URI } from "../../../../../base/common/uri.js";
import { type EditorInput, IEditorService } from "../../../../services/editor/common/editorService.js";
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { IDebugService, type IDebugSourceContent, type IDebugVariable } from "../../../../services/debug/common/debugService.js";
import { DebugViewTestServices, MockDebugService, MockDebugSession } from "../common/mockDebug.js";

test("Debug view switches sessions and renders threads, recursive variables, watches, and source references", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const opened: unknown[] = [];
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async (input: EditorInput) => { opened.push(input); }, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService();
		debug.activate(debug.sessions[0]!);
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "ash.debug.test", title: "Debug" });
		browser.window.document.body.append(view.element);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-frame").length === 1);

		assert.equal(view.element.querySelectorAll("select[aria-label='Active debug session'] option").length, 2);
		assert.equal(view.element.querySelectorAll("select[aria-label='Debug thread'] option").length, 2);
		assert.match(view.element.querySelector(".ash-debug-watch-value")?.textContent ?? "", /answer = 42/);
		assert.match(view.element.querySelectorAll(".ash-debug-variable")[1]?.textContent ?? "", /parent/);

		(view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[1]!).click();
		await waitFor(() => [...view.element.querySelectorAll(".ash-debug-variable")].some(element => /child = value/.test(element.textContent ?? "")));

		(view.element.querySelector<HTMLButtonElement>(".ash-debug-frame")!).click();
		await waitFor(() => opened.length === 2);
		const openedInput = opened[0] as EditorInput;
		assert.equal(openedInput.resource.scheme, "debug-source");
		assert.deepEqual({ ...openedInput, resource: undefined }, { resource: undefined, label: "generated.ts", contentType: "text/typescript", readOnly: true, initialText: "const generated = true;" });

		const caught = view.element.querySelector<HTMLInputElement>("input[data-exception-filter='caught']")!;
		caught.checked = true;
		caught.dispatchEvent(new browser.window.Event("change", { bubbles: true }));
		await waitFor(() => debug.exceptionBreakpoints.includes("caught"));
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Debug view opens an authority-qualified Remote stack source", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let opened: EditorInput | undefined;
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async (input: EditorInput) => { opened = input; }, focusActiveEditor() {} };
	const resource = URI.parse("ash-remote://ssh+work-server/srv/project/src/main.ts");
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService({ name: "main.ts", path: "/srv/project/src/main.ts", resource });
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "ash.debug.remote.test", title: "Debug" });
		browser.window.document.body.append(view.element);
		debug.activate(debug.sessions[0]!);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-frame").length === 1);

		await waitFor(() => opened !== undefined);

		assert.equal(opened?.resource.toString(), resource.toString());
		assert.equal(opened?.label, "main.ts");
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Debug controls follow session state, dispatch actions, and retain collapsed sections across refreshes", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async () => {}, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService();
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "ash.debug.controls.test", title: "Debug" });
		const action = (label: string) => view.element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
		const toolbar = view.element.querySelector<HTMLElement>(".ash-toolbar")!;
		assert.equal(toolbar.hidden, true);
		action("Start Debugging").click();
		assert.deepEqual(debug.operations, ["start"]);

		const session = debug.sessions[0] as MockDebugSession;
		debug.activate(session);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-frame").length === 1);
		assert.deepEqual([toolbar.hidden, action("Continue").disabled, action("Step Over").disabled], [false, false, false]);
		action("Step Over").click();
		assert.deepEqual(session.operations, ["stepOver"]);

		const variables = view.element.querySelector(".ash-debug-variables")!.closest(".ash-debug-section")!.querySelector<HTMLButtonElement>(".ash-pane-view-header-button")!;
		variables.click();
		session.state = "running";
		debug.activate(session);
		assert.deepEqual([action("Pause").disabled, action("Step Over").disabled, variables.getAttribute("aria-expanded")], [false, true, "false"]);
		action("Pause").click();
		assert.deepEqual(session.operations, ["stepOver", "pause"]);

		action("Stop").click();
		assert.deepEqual(debug.operations, ["start", "stop"]);
		debug.activate(undefined);
		assert.equal(toolbar.hidden, true);
		debug.configurations = [];
		await debug.refresh();
		assert.equal(action("Start Debugging").disabled, true);
		assert.equal(view.element.querySelector<HTMLSelectElement>("select[aria-label='Debug configuration']")!.disabled, true);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Debug view initializes Chinese labels and retains its draft and collapsed section during refresh", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async () => {}, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService();
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === "zh-CN")!;
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "ash.debug.locale.test", title: "Debug" });
		const watch = view.element.querySelector(".ash-debug-watch")!.closest(".ash-debug-section")!.querySelector<HTMLButtonElement>(".ash-pane-view-header-button")!;
		const input = view.element.querySelector<HTMLInputElement>(".ash-debug-input-form input")!;
		input.value = "myValue";
		watch.click();
		await debug.refresh();
		assert.deepEqual([...view.element.querySelectorAll(".ash-debug-section .ash-pane-view-header-title")].map(title => title.textContent), ["变量", "监视", "调用堆栈", "断点"]);
		assert.deepEqual([input.value, watch.getAttribute("aria-expanded"), input.getAttribute("aria-label")], ["myValue", "false", "添加监视表达式"]);
		assert.equal(view.element.querySelector("button[aria-label='启动调试']")?.textContent, "启动调试");
		debug.activate(debug.sessions[0]);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-variable").length === 2);
		view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[1]!.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		const valueInput = view.element.querySelector<HTMLInputElement>(".ash-debug-variable-edit input")!;
		assert.deepEqual([valueInput.getAttribute("aria-label"), valueInput.getAttribute("aria-description")], ["parent 的值", "按 Enter 应用新值，按 Escape 取消。"]);
	} finally {
		resetNlsResolver();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

const contextMenus: IContextMenuService = { onDidShowContextMenu: CommonEvent.None, onDidHideContextMenu: CommonEvent.None, showContextMenu() {}, hideContextMenu() {} };

test("Debug variable editing uses its parent reference, refreshes watches, cancels, and restores focus", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const globals = installDomGlobals(browser);
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async () => {}, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService();
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "debug.edit", title: "Debug" });
		browser.window.document.body.append(view.element);
		const session = debug.sessions[0] as MockDebugSession;
		debug.activate(session);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-variable").length === 2);
		view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[1]!.click();
		await waitFor(() => view.element.querySelectorAll(".ash-debug-variable").length === 3);
		const child = view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[2]!;
		const key = child.dataset.variableKey;
		child.focus();
		child.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		let input = view.element.querySelector<HTMLInputElement>(".ash-debug-variable-edit input")!;
		assert.equal(input.getAttribute("aria-label"), "Value of child");
		input.value = "cancelled";
		input.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		assert.deepEqual(session.assignments, []);
		const restored = view.element.querySelector<HTMLButtonElement>(`[data-variable-key="${key}"]`)!;
		assert.equal(browser.window.document.activeElement, restored);
		restored.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		input = view.element.querySelector<HTMLInputElement>(".ash-debug-variable-edit input")!;
		input.value = "43";
		input.closest("form")!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => view.element.querySelector(".ash-debug-variable-edit") === null);
		assert.deepEqual(session.assignments, [{ reference: 21, name: "child", value: "43" }]);
		assert.match(view.element.querySelector(`[data-variable-key="${key}"]`)!.textContent!, /child = 43/);
		assert.match(view.element.querySelector(".ash-debug-watch-value")!.textContent!, /answer = 43/);
		assert.equal(browser.window.document.activeElement, view.element.querySelector(`[data-variable-key="${key}"]`));
		const parent = view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[1]!;
		parent.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		input = view.element.querySelector<HTMLInputElement>(".ash-debug-variable-edit input")!;
		input.value = "scalar";
		input.closest("form")!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => view.element.querySelector(".ash-debug-variable-edit") === null);
		assert.deepEqual(session.assignments.at(-1), { reference: 20, name: "parent", value: "scalar" });
		assert.equal(view.element.querySelectorAll(".ash-debug-variable").length, 2);
		assert.match(parent.textContent!, /parent = scalar/);
		assert.equal(parent.hasAttribute("aria-expanded"), false);
	} finally {
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Debug source failures preserve variable and Watch inspection", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const globals = installDomGlobals(browser);
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async () => { throw new Error("Source unavailable"); }, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService({ name: "main.ts", resource: URI.file('/workspace/main.ts') });
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "debug.sourceError", title: "Debug" });
		debug.activate(debug.sessions[0]);
		await waitFor(() => view.element.querySelector(".ash-debug-status")?.textContent === "Source unavailable");
		assert.equal(view.element.querySelectorAll(".ash-debug-variable").length, 2);
		assert.match(view.element.querySelector(".ash-debug-watch-value")!.textContent!, /answer = 42/);
	} finally {
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Debug inspection retires pending variable and virtual source replies when execution resumes", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const globals = installDomGlobals(browser);
	const opened: EditorInput[] = [];
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async input => { opened.push(input); }, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService();
		const session = debug.sessions[0] as MockDebugSession;
		const source = new DeferredPromise<IDebugSourceContent>();
		let sourceRequested = false;
		session.source = async () => { sourceRequested = true; return source.p; };
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "debug.delayed", title: "Debug" });
		debug.activate(session);
		await waitFor(() => sourceRequested);
		session.state = "running";
		debug.activate(session);
		await source.complete({ content: "obsolete" });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(opened, []);
		assert.equal(view.element.querySelectorAll(".ash-debug-frame").length, 0);

		session.source = async () => ({ content: "current" });
		const variables = new DeferredPromise<readonly IDebugVariable[]>();
		let variablesRequested = false;
		session.variables = async () => { variablesRequested = true; return variables.p; };
		session.state = "stopped";
		debug.activate(session);
		await waitFor(() => variablesRequested);
		session.state = "running";
		debug.activate(session);
		await variables.complete([{ name: "obsolete", value: "42", variablesReference: 0 }]);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(view.element.querySelectorAll(".ash-debug-variable, .ash-debug-frame").length, 0);
	} finally {
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Debug variable editing respects read-only hints, retains adapter errors, and retires an in-flight assignment on session switch", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const globals = installDomGlobals(browser);
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async () => {}, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService();
		const session = debug.sessions[0] as MockDebugSession;
		session.variables = async () => [
			{ name: "locked", value: "1", variablesReference: 0, presentationHint: { attributes: ["readOnly"] } },
			{ name: "editable", value: "2", variablesReference: 0 },
		];
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "debug.error", title: "Debug" });
		browser.window.document.body.append(view.element);
		debug.activate(session);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-variable").length === 3);
		view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[1]!.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		assert.equal(view.element.querySelector(".ash-debug-variable-edit"), null);
		session.setVariable = async () => { throw new Error("Value must be numeric."); };
		view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[2]!.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		const input = view.element.querySelector<HTMLInputElement>(".ash-debug-variable-edit input")!;
		input.value = "invalid";
		input.closest("form")!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => input.getAttribute("aria-invalid") === "true");
		assert.deepEqual([input.value, input.readOnly, browser.window.document.activeElement === input], ["invalid", false, true]);
		assert.equal(view.element.querySelector(".ash-input-box-message")?.textContent, "Value must be numeric.");
		const assignment = new DeferredPromise<IDebugVariable>();
		session.setVariable = async () => assignment.p;
		input.value = "3";
		input.closest("form")!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		debug.activate(debug.sessions[1]);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-variable").length === 2);
		await assignment.complete({ name: "editable", value: "obsolete", variablesReference: 0 });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(view.element.querySelector(".ash-debug-variable-edit"), null);
		assert.doesNotMatch(view.element.querySelector(".ash-debug-variables")!.textContent!, /obsolete|editable/);
	} finally {
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Debug welcome creates a launch document and reopens existing configuration without overwriting it", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const globals = installDomGlobals(browser);
	const opened: EditorInput[] = [];
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async input => { opened.push(input); }, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new MockDebugService();
		debug.configurations = [];
		using support = new DebugViewTestServices();
		using services = new InstantiationService(support.register(new ServiceCollection([IDebugService, debug], [IEditorService, editor], [IContextMenuService, contextMenus])));
		using view = services.createInstance(DebugViewPane, browser.window.document.body, { id: "debug.welcome", title: "Debug" });
		assert.deepEqual([...view.element.querySelectorAll(".ash-debug-section .ash-pane-view-header-title")].map(title => title.textContent), ["Run"]);
		const create = view.element.querySelector<HTMLButtonElement>(".ash-debug-welcome-content button")!;
		create.click();
		await waitFor(() => opened.length === 1);
		const resource = URI.file("/workspace/.vscode/launch.json").toString();
		assert.deepEqual(JSON.parse(support.documents.get(resource)!), { version: "0.2.0", configurations: [] });
		support.documents.set(resource, "user configuration");
		create.click();
		await waitFor(() => opened.length === 2);
		assert.deepEqual([support.writes, support.documents.get(resource), opened.map(input => input.resource.toString())], [1, "user configuration", [resource, resource]]);
	} finally {
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

async function waitFor(predicate: () => boolean): Promise<void> { const deadline = Date.now() + 2_000; while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for Debug view"); await new Promise(resolve => setTimeout(resolve, 10)); } }
function installDomGlobals(browser: JSDOM): readonly string[] { const globals = { window: browser.window, document: browser.window.document, Node: browser.window.Node, Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Event: browser.window.Event, MouseEvent: browser.window.MouseEvent, navigator: browser.window.navigator }; for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value }); return Object.keys(globals); }
