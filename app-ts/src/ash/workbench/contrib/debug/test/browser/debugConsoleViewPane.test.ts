import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { IDebugConsoleService, IDebugConsoleSession } from "../../../../services/debug/common/debugConsoleService.js";

test("Debug Console renders retained output, evaluates expressions, and exposes its clear icon action", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	try {
		const { DebugConsoleViewPane } = await import("../../browser/debugConsoleViewPane.js");
		using consoleService = new FakeDebugConsoleService();
		using view = new DebugConsoleViewPane(browser.window.document.body, { id: "ash.debugConsole.test", title: "Debug Console" }, consoleService);
		browser.window.document.body.append(view.element);
		assert.equal(view.element.querySelector(".ash-debug-console-output")?.textContent, "ready\n");

		const input = view.element.querySelector<HTMLInputElement>("input[aria-label='Debug Console expression']")!;
		input.value = "answer";
		input.form!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => /42/.test(view.element.querySelector(".ash-debug-console-output")?.textContent ?? ""));

		const actions = view.partTitleProjection.actions!;
		const clear = actions.querySelector<HTMLButtonElement>("[data-action-id='workbench.debug.panel.action.clearReplAction'] button")!;
		assert.ok(clear.querySelector("svg"));
		clear.click();
		assert.equal(view.element.querySelector(".ash-debug-console-output")?.textContent, "");
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

class FakeDebugConsoleService extends Disposable implements IDebugConsoleService {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private output = "ready\n";
	readonly onDidChange = this.changeEmitter.event;
	get sessions(): readonly IDebugConsoleSession[] { return Object.freeze([this.snapshot()]); }
	get activeSession(): IDebugConsoleSession { return this.snapshot(); }
	selectSession() {}
	clear(): void { this.output = ""; this.changeEmitter.fire(); }
	async evaluate(expression: string): Promise<void> { this.output += `> ${expression}\n42\n`; this.changeEmitter.fire(); }
	private snapshot(): IDebugConsoleSession { return Object.freeze({ id: "one", label: "One", state: "stopped", output: this.output, canEvaluate: true }); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Debug Console");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = { window: browser.window, document: browser.window.document, Node: browser.window.Node, Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Event: browser.window.Event, MouseEvent: browser.window.MouseEvent, navigator: browser.window.navigator };
	for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
	return Object.keys(globals);
}
