import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { type EditorInput, type IEditorService } from "../../../../services/editor/common/editorService.js";
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { type DebugEvaluateContext, type DebugSessionState, type IDebugBreakpoint, type IDebugCompound, type IDebugConfiguration, type IDebugEvaluateResult, type IDebugScope, type IDebugService, type IDebugSession, type IDebugSource, type IDebugSourceContent, type IDebugStackFrame, type IDebugThread, type IDebugVariable } from "../../../../services/debug/common/debugService.js";

test("Debug view switches sessions and renders threads, recursive variables, watches, and source references", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const opened: unknown[] = [];
	const editor: IEditorService = { ...emptyEditorServiceState, openEditor: async (input: EditorInput) => { opened.push(input); }, focusActiveEditor() {} };
	try {
		const { DebugViewPane } = await import("../../browser/debugViewPane.js");
		using debug = new FakeDebugService();
		using view = new DebugViewPane(browser.window.document.body, { id: "ash.debug.test", title: "Debug" }, debug, editor);
		browser.window.document.body.append(view.element);
		debug.activate(debug.sessions[0]!);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-frame").length === 1);

		assert.equal(view.element.querySelectorAll("select[aria-label='Active debug session'] option").length, 2);
		assert.equal(view.element.querySelectorAll("select[aria-label='Debug thread'] option").length, 2);
		assert.match(view.element.querySelector(".ash-debug-watch-value")?.textContent ?? "", /answer = 42/);
		assert.match(view.element.querySelectorAll(".ash-debug-variable")[1]?.textContent ?? "", /parent/);

		(view.element.querySelectorAll<HTMLButtonElement>(".ash-debug-variable")[1]!).click();
		await waitFor(() => [...view.element.querySelectorAll(".ash-debug-variable")].some(element => /child = value/.test(element.textContent ?? "")));

		(view.element.querySelector<HTMLButtonElement>(".ash-debug-frame")!).click();
		await waitFor(() => opened.length === 1);
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
		using debug = new FakeDebugService({ name: "main.ts", path: "/srv/project/src/main.ts", resource });
		using view = new DebugViewPane(browser.window.document.body, { id: "ash.debug.remote.test", title: "Debug" }, debug, editor);
		browser.window.document.body.append(view.element);
		debug.activate(debug.sessions[0]!);
		await waitFor(() => view.element.querySelectorAll(".ash-debug-frame").length === 1);

		(view.element.querySelector<HTMLButtonElement>(".ash-debug-frame")!).click();
		await waitFor(() => opened !== undefined);

		assert.equal(opened?.resource.toString(), resource.toString());
		assert.equal(opened?.label, "main.ts");
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

class FakeDebugService extends Disposable implements IDebugService {
	private readonly configurationEmitter = this._register(new Emitter<readonly IDebugConfiguration[]>());
	private readonly breakpointEmitter = this._register(new Emitter<readonly IDebugBreakpoint[]>());
	private readonly watchEmitter = this._register(new Emitter<readonly string[]>());
	private readonly exceptionEmitter = this._register(new Emitter<readonly string[]>());
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	readonly configurations = Object.freeze([configuration("One")]);
	readonly compounds: readonly IDebugCompound[] = Object.freeze([]);
	readonly breakpoints: readonly IDebugBreakpoint[] = Object.freeze([]);
	readonly watchExpressions = Object.freeze(["answer"]);
	exceptionBreakpoints: readonly string[] = Object.freeze(["uncaught"]);
	readonly sessions: readonly IDebugSession[];
	session: IDebugSession | undefined;
	readonly onDidChangeConfigurations = this.configurationEmitter.event;
	readonly onDidChangeBreakpoints = this.breakpointEmitter.event;
	readonly onDidChangeWatchExpressions = this.watchEmitter.event;
	readonly onDidChangeExceptionBreakpoints = this.exceptionEmitter.event;
	readonly onDidChangeSession = this.sessionEmitter.event;
	constructor(source: IDebugSource = { name: "generated.ts", sourceReference: 33 }) { super(); this.sessions = Object.freeze([this._register(new FakeDebugSession("session-one", "One", source)), this._register(new FakeDebugSession("session-two", "Two", source))]); }
	async refresh() { return this.configurations; }
	async start() { return this.sessions[0]!; }
	async startCompound() { return this.sessions; }
	setActiveSession(session: IDebugSession): void { this.activate(session); }
	async restart(session = this.session) { return session!; }
	async stop() {}
	async stopAll() {}
	toggleBreakpoint() {}
	removeBreakpoint() {}
	addWatchExpression() {}
	removeWatchExpression() {}
	async setExceptionBreakpoints(filters: readonly string[]) { this.exceptionBreakpoints = Object.freeze([...filters]); this.exceptionEmitter.fire(this.exceptionBreakpoints); }
	activate(session: IDebugSession): void { this.session = session; this.sessionEmitter.fire(session); }
}

class FakeDebugSession extends Disposable implements IDebugSession {
	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly outputEmitter = this._register(new Emitter<string>());
	private selectedThread = 1;
	readonly configuration: IDebugConfiguration;
	readonly capabilities = Object.freeze({ supportsRestart: true, supportsTerminate: true, exceptionBreakpointFilters: Object.freeze([{ filter: "uncaught", label: "Uncaught", default: true }, { filter: "caught", label: "Caught", default: false }]) });
	readonly state: DebugSessionState = "stopped";
	readonly reason = "breakpoint";
	readonly onDidChangeState = this.stateEmitter.event;
	readonly onDidOutput = this.outputEmitter.event;
	readonly output = "";
	constructor(readonly id: string, name: string, private readonly stackSource: IDebugSource) { super(); this.configuration = configuration(name); }
	get threadId() { return this.selectedThread; }
	async continue() {}
	async pause() {}
	async stepOver() {}
	async stepInto() {}
	async stepOut() {}
	async restart() {}
	async threads(): Promise<readonly IDebugThread[]> { return Object.freeze([{ id: 1, name: "main" }, { id: 2, name: "worker" }]); }
	selectThread(threadId: number): void { this.selectedThread = threadId; }
	async stackTrace(): Promise<readonly IDebugStackFrame[]> { return Object.freeze([{ id: 10, name: "main", source: this.stackSource, lineNumber: 1, columnNumber: 1 }]); }
	async scopes(): Promise<readonly IDebugScope[]> { return Object.freeze([{ name: "Locals", variablesReference: 20, expensive: false }]); }
	async variables(reference: number): Promise<readonly IDebugVariable[]> { return reference === 20 ? Object.freeze([{ name: "parent", value: "Object", variablesReference: 21 }]) : Object.freeze([{ name: "child", value: "value", variablesReference: 0 }]); }
	async evaluate(_expression: string, _frameId: number | undefined, _context: DebugEvaluateContext): Promise<IDebugEvaluateResult> { return { result: "42", type: "number", variablesReference: 0 }; }
	async source(_source: IDebugSource): Promise<IDebugSourceContent> { return { content: "const generated = true;", mimeType: "text/typescript" }; }
	async setExceptionBreakpoints() {}
	async disconnect() {}
}

function configuration(name: string): IDebugConfiguration { return { id: name, name, type: "demo", request: "launch", adapter: { program: "adapter", arguments: [] }, arguments: {} }; }
async function waitFor(predicate: () => boolean): Promise<void> { const deadline = Date.now() + 2_000; while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for Debug view"); await new Promise(resolve => setTimeout(resolve, 10)); } }
function installDomGlobals(browser: JSDOM): readonly string[] { const globals = { window: browser.window, document: browser.window.document, Node: browser.window.Node, Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Event: browser.window.Event, MouseEvent: browser.window.MouseEvent, navigator: browser.window.navigator }; for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value }); return Object.keys(globals); }
