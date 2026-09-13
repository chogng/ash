import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { IAction } from "../../../../../base/common/actions.js";
import { Event } from "../../../../../base/common/event.js";
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import { OutputService } from "../../../../../workbench/services/output/browser/outputService.js";
import type { ITaskService } from "../../../../../workbench/services/tasks/common/taskService.js";
import type { ITerminalService } from "../../../../../workbench/services/terminal/common/terminal.js";
import type { IViewsService } from "../../../../../workbench/services/views/browser/viewsService.js";

test("Output projects channel selection and active-channel clearing into the Panel title", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let shownActions: readonly IAction[] = [];
	const contextMenus: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: options => { shownActions = options.getActions?.() ?? []; },
		hideContextMenu() {},
	};
	try {
		using output = new OutputService();
		using rust = output.createChannel({ id: "rust", label: "rust-analyzer" });
		using typescript = output.createChannel({ id: "typescript", label: "TypeScript" });
		rust.append({ severity: "warning", text: "check failed" });
		typescript.append({ severity: "log", text: "server ready" });
		const { OutputViewPane } = await import("../../../../../workbench/contrib/output/browser/outputViewPane.js");
		using pane = new OutputViewPane(browser.window.document.body, { id: "ash.output.test", title: "Output" }, output, contextMenus);
		const titleActions = pane.partTitleProjection?.actions;
		assert.ok(titleActions);
		browser.window.document.body.append(pane.element, titleActions);
		const selectChannel = titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.output.selectChannel'] button");
		const clearOutput = titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.output.clear'] button");
		assert.ok(selectChannel);
		assert.ok(clearOutput);
		assert.ok(clearOutput.querySelector("svg.ash-icon"));
		assert.match(pane.element.querySelector(".ash-output-content")?.textContent ?? "", /check failed/);
		clearOutput.click();
		assert.deepEqual(rust.entries, []);
		titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.output.selectChannel'] button")?.click();
		const typescriptAction = shownActions.find(action => action.label === "TypeScript");
		assert.ok(typescriptAction);
		await typescriptAction.run();
		assert.equal(output.activeChannel, typescript);
		assert.match(pane.element.querySelector(".ash-output-content")?.textContent ?? "", /server ready/);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Tasks projects its refresh action into the Panel title", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let refreshCount = 0;
	const tasks = {
		tasks: [],
		activeRuns: [],
		lastRun: undefined,
		onDidChangeTasks: Event.None,
		onDidStartTask: Event.None,
		onDidChangeTaskRun: Event.None,
		registerTaskProvider: () => toDisposable(() => undefined),
		registerTaskProviders: () => ({ replace() {}, dispose() {}, [Symbol.dispose]() {} }),
		refresh: async () => { refreshCount += 1; return []; },
		run: async () => { throw new Error("Task execution is not expected"); },
		terminate: async () => undefined,
		dispose() {},
		[Symbol.dispose]() {},
	} as ITaskService;
	const views: IViewsService = { openView: () => undefined, focusView: () => false };
	const terminals = { instances: [] } as unknown as ITerminalService;
	try {
		const { TasksViewPane } = await import("../../../../../workbench/contrib/tasks/browser/tasksViewPane.js");
		using pane = new TasksViewPane(browser.window.document.body, { id: "ash.tasks.test", title: "Tasks" }, tasks, views, terminals);
		const titleActions = pane.partTitleProjection?.actions;
		assert.ok(titleActions);
		browser.window.document.body.append(pane.element, titleActions);
		await waitFor(() => !titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.tasks.refresh'] button")?.disabled);
		const refreshTasks = titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.tasks.refresh'] button");
		assert.ok(refreshTasks);
		assert.ok(refreshTasks.querySelector("svg.ash-icon"));
		assert.equal(pane.element.querySelector(".ash-tasks-refresh"), null);
		refreshTasks.click();
		await waitFor(() => refreshCount === 2);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Panel title action");
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
	return Object.keys(globals);
}
