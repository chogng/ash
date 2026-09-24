import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { Checkbox } from "../../../../base/browser/ui/toggle/toggle.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import { type IEditorService } from "../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { type IDebugBreakpoint, type IDebugConfiguration, type IDebugEvaluateResult, type IDebugScope, type IDebugService, type IDebugSession, type IDebugStackFrame, type IDebugThread, type IDebugVariable } from "../../../services/debug/common/debugService.js";

interface DebugVariableRow {
	readonly key: number;
	readonly name: string;
	readonly value?: string;
	readonly type?: string;
	readonly variablesReference: number;
	readonly depth: number;
	readonly expanded: boolean;
}

interface DebugWatchResult {
	readonly expression: string;
	readonly result?: IDebugEvaluateResult;
	readonly error?: string;
}

/** Code Debug sidebar with multi-session inspection, recursive variables, watches, and exceptions. */
export class DebugViewPane extends ViewPane {
	private readonly configurationsElement: HTMLSelectElement;
	private readonly sessionsElement: HTMLSelectElement;
	private readonly threadsElement: HTMLSelectElement;
	private readonly statusElement: HTMLDivElement;
	private readonly stackElement: HTMLUListElement;
	private readonly variablesElement: HTMLUListElement;
	private readonly watchElement: HTMLUListElement;
	private readonly watchForm: HTMLFormElement;
	private readonly watchInput: HTMLInputElement;
	private readonly exceptionsElement: HTMLUListElement;
	private readonly breakpointsElement: HTMLUListElement;
	private readonly exceptionControls = this._register(new DisposableStore());
	private threads: readonly IDebugThread[] = [];
	private frames: readonly IDebugStackFrame[] = [];
	private variableRows: readonly DebugVariableRow[] = [];
	private watchResults: readonly DebugWatchResult[] = [];
	private inspectedSessionId: string | undefined;
	private selectedFrameId: number | undefined;
	private variableKey = 0;
	private refreshGeneration = 0;
	private error: string | undefined;

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly debug: IDebugService, private readonly editor: IEditorService) {
		super(container, options);
		this.contentElement.classList.add("ash-debug");
		const controls = h(container.ownerDocument, "div");
		controls.className = "ash-debug-controls";
		this.configurationsElement = select(container.ownerDocument, "Debug configuration");
		this.sessionsElement = select(container.ownerDocument, "Active debug session");
		controls.append(this.configurationsElement, this.sessionsElement, ...[button(container.ownerDocument, "Start", "start"), button(container.ownerDocument, "Continue", "continue"), button(container.ownerDocument, "Pause", "pause"), button(container.ownerDocument, "Restart", "restart"), button(container.ownerDocument, "Over", "stepOver"), button(container.ownerDocument, "Into", "stepInto"), button(container.ownerDocument, "Out", "stepOut"), button(container.ownerDocument, "Stop", "stop"), button(container.ownerDocument, "Stop All", "stopAll")]);
		this.statusElement = h(container.ownerDocument, "div");
		this.statusElement.className = "ash-debug-status";
		this.statusElement.setAttribute("role", "status");
		this.threadsElement = select(container.ownerDocument, "Debug thread");
		this.threadsElement.classList.add("ash-debug-thread-select");
		this.stackElement = section(container.ownerDocument, "Call Stack", "ash-debug-stack");
		this.variablesElement = section(container.ownerDocument, "Variables", "ash-debug-variables");
		this.watchElement = section(container.ownerDocument, "Watch", "ash-debug-watch");
		[this.watchForm, this.watchInput] = inputForm(container.ownerDocument, "Add watch expression", "Add");
		this.exceptionsElement = section(container.ownerDocument, "Exception Breakpoints", "ash-debug-exceptions");
		this.breakpointsElement = section(container.ownerDocument, "Breakpoints", "ash-debug-breakpoints");
		this.contentElement.append(controls, this.statusElement, this.threadsElement, this.stackElement, this.variablesElement, this.watchElement, this.watchForm, this.exceptionsElement, this.breakpointsElement);
		this._register(addDisposableListener(controls, "click", event => this.control(event)));
		this._register(addDisposableListener(this.sessionsElement, "change", () => this.selectSession()));
		this._register(addDisposableListener(this.threadsElement, "change", () => { void this.selectThread(); }));
		this._register(addDisposableListener(this.stackElement, "click", event => this.activateFrame(event)));
		this._register(addDisposableListener(this.variablesElement, "click", event => this.expandVariable(event)));
		this._register(addDisposableListener(this.watchElement, "click", event => this.removeWatch(event)));
		this._register(addDisposableListener(this.watchForm, "submit", event => this.addWatch(event)));
		this._register(addDisposableListener(this.exceptionsElement, "change", () => { void this.changeExceptionBreakpoints(); }));
		this._register(addDisposableListener(this.breakpointsElement, "click", event => this.activateBreakpoint(event)));
		this._register(debug.onDidChangeConfigurations(() => this.render()));
		this._register(debug.onDidChangeBreakpoints(() => this.render()));
		this._register(debug.onDidChangeWatchExpressions(() => { void this.refreshWatches(); this.render(); }));
		this._register(debug.onDidChangeExceptionBreakpoints(() => this.render()));
		this._register(debug.onDidChangeSession(session => this.acceptSessionChange(session)));
		this.render();
		void debug.refresh().catch(error => { this.error = message(error); this.render(); });
	}

	private control(event: Event): void {
		const target = event.target instanceof this.element.ownerDocument.defaultView!.Element ? event.target.closest<HTMLButtonElement>("button[data-operation]") : null;
		const operation = target?.dataset.operation;
		if (!operation) return;
		this.error = undefined;
		const session = this.debug.session;
		const action = operation === "start" ? this.startSelected()
			: operation === "restart" ? this.debug.restart()
			: operation === "stop" ? this.debug.stop()
			: operation === "stopAll" ? this.debug.stopAll()
			: session && operation in session ? (session[operation as "continue" | "pause" | "restart" | "stepOver" | "stepInto" | "stepOut"] as () => Promise<void>).call(session)
			: Promise.resolve();
		void action.catch(error => { this.error = message(error); this.render(); });
	}

	private async startSelected(): Promise<void> {
		const configuration = this.debug.configurations.find(candidate => candidate.id === this.configurationsElement.value);
		const compound = this.debug.compounds.find(candidate => candidate.id === this.configurationsElement.value);
		if (!configuration && !compound) throw new Error("No debug configuration found in .vscode/launch.json");
		if (configuration) await this.debug.start(configuration);
		else await this.debug.startCompound(compound!);
	}

	private acceptSessionChange(session: IDebugSession | undefined): void {
		if (this.inspectedSessionId !== session?.id) {
			this.inspectedSessionId = session?.id;
			this.threads = [];
			this.frames = [];
			this.variableRows = [];
			this.watchResults = [];
			this.selectedFrameId = undefined;
		}
		if (session?.state === "stopped") void this.refreshStoppedState();
		else if (session?.state === "running") { this.threads = []; this.frames = []; this.variableRows = []; this.watchResults = []; this.selectedFrameId = undefined; }
		this.render();
	}

	private selectSession(): void {
		const session = this.debug.sessions.find(candidate => candidate.id === this.sessionsElement.value);
		if (session) this.debug.setActiveSession(session);
	}

	private async selectThread(): Promise<void> {
		const session = this.debug.session;
		const threadId = Number(this.threadsElement.value);
		if (!session || !Number.isSafeInteger(threadId) || threadId <= 0) return;
		session.selectThread(threadId);
		await this.refreshStoppedState();
	}

	private async refreshStoppedState(): Promise<void> {
		const session = this.debug.session;
		if (!session || session.state !== "stopped") return;
		const generation = ++this.refreshGeneration;
		try {
			const threads = await session.threads();
			const selectedThread = threads.find(thread => thread.id === session.threadId) ?? threads[0];
			if (!selectedThread) throw new Error("The Debug Adapter did not report any stopped threads");
			session.selectThread(selectedThread.id);
			const frames = await session.stackTrace(selectedThread.id);
			if (generation !== this.refreshGeneration || this.debug.session !== session) return;
			this.threads = threads;
			this.frames = frames;
			this.selectedFrameId = frames[0]?.id;
			await this.loadFrameVariables(session, frames[0]?.id, generation);
			await this.refreshWatches();
		} catch (error) { this.error = message(error); }
		this.render();
	}

	private async loadFrameVariables(session: IDebugSession, frameId: number | undefined, generation = this.refreshGeneration): Promise<void> {
		if (frameId === undefined) { this.variableRows = []; return; }
		const scopes = await session.scopes(frameId);
		const variables = await Promise.all(scopes.map(scope => scope.variablesReference > 0 ? session.variables(scope.variablesReference) : Promise.resolve(Object.freeze([]) as readonly IDebugVariable[])));
		if (generation !== this.refreshGeneration || this.debug.session !== session || this.selectedFrameId !== frameId) return;
		this.variableRows = Object.freeze(scopes.flatMap((scope, index) => [this.scopeRow(scope), ...variables[index]!.map(variable => this.variableRow(variable, 1))]));
	}

	private activateFrame(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-frame", "frameIndex", this.element.ownerDocument);
		const frame = index === undefined ? undefined : this.frames[index];
		const session = this.debug.session;
		if (!frame || !session) return;
		void (async () => {
			this.selectedFrameId = frame.id;
			await this.openFrameSource(session, frame);
			await this.loadFrameVariables(session, frame.id);
			await this.refreshWatches();
			this.render();
		})().catch(error => { this.error = message(error); this.render(); });
	}

	private async openFrameSource(session: IDebugSession, frame: IDebugStackFrame): Promise<void> {
		const position = new Position(Math.max(1, frame.lineNumber), Math.max(1, frame.columnNumber));
		if (frame.source?.resource) {
			await this.editor.openEditor({ resource: frame.source.resource, label: frame.source.name }, { selection: Range.fromPositions(position) });
			return;
		}
		if (frame.source?.sourceReference && frame.source.sourceReference > 0) {
			const source = await session.source(frame.source);
			const name = frame.source.name ?? `source-${frame.source.sourceReference}`;
			const resource = URI.parse(`debug-source://session/${encodeURIComponent(session.id)}/${frame.source.sourceReference}/${encodeURIComponent(name)}`);
			await this.editor.openEditor({ resource, label: name, contentType: source.mimeType, readOnly: true, initialText: source.content }, { selection: Range.fromPositions(position) });
		}
	}

	private expandVariable(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-variable", "variableIndex", this.element.ownerDocument);
		const row = index === undefined ? undefined : this.variableRows[index];
		const session = this.debug.session;
		if (!row || !session || row.variablesReference <= 0) return;
		if (row.expanded) {
			const end = descendantEnd(this.variableRows, index!, row.depth);
			this.variableRows = Object.freeze([...this.variableRows.slice(0, index), { ...row, expanded: false }, ...this.variableRows.slice(end)]);
			this.render();
			return;
		}
		void session.variables(row.variablesReference).then(variables => {
			const currentIndex = this.variableRows.findIndex(candidate => candidate.key === row.key);
			if (currentIndex < 0) return;
			const children = variables.map(variable => this.variableRow(variable, row.depth + 1));
			this.variableRows = Object.freeze([...this.variableRows.slice(0, currentIndex), { ...row, expanded: true }, ...children, ...this.variableRows.slice(currentIndex + 1)]);
			this.render();
		}, error => { this.error = message(error); this.render(); });
	}

	private addWatch(event: Event): void {
		event.preventDefault();
		const expression = this.watchInput.value;
		this.debug.addWatchExpression(expression);
		this.watchInput.value = "";
	}

	private removeWatch(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-watch-remove", "watchIndex", this.element.ownerDocument);
		const expression = index === undefined ? undefined : this.debug.watchExpressions[index];
		if (expression) this.debug.removeWatchExpression(expression);
	}

	private async refreshWatches(): Promise<void> {
		const session = this.debug.session;
		const expressions = this.debug.watchExpressions;
		if (!session || session.state !== "stopped") { this.watchResults = expressions.map(expression => ({ expression })); return; }
		const frameId = this.selectedFrameId;
		this.watchResults = Object.freeze(await Promise.all(expressions.map(async expression => {
			try { return { expression, result: await session.evaluate(expression, frameId, "watch") }; }
			catch (error) { return { expression, error: message(error) }; }
		})));
	}

	private async changeExceptionBreakpoints(): Promise<void> {
		const filters = [...this.exceptionsElement.querySelectorAll<HTMLInputElement>("input[data-exception-filter]:checked")].map(input => input.dataset.exceptionFilter!).filter(Boolean);
		try { await this.debug.setExceptionBreakpoints(filters); }
		catch (error) { this.error = message(error); this.render(); }
	}

	private activateBreakpoint(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-breakpoint", "breakpointIndex", this.element.ownerDocument);
		const breakpoint = index === undefined ? undefined : this.debug.breakpoints[index];
		const remove = event.target instanceof this.element.ownerDocument.defaultView!.Element && Boolean(event.target.closest(".ash-debug-breakpoint-remove"));
		if (!breakpoint) return;
		if (remove) this.debug.removeBreakpoint(breakpoint.id);
		else void this.editor.openEditor({ resource: breakpoint.resource }, { selection: lineSelection(breakpoint.lineNumber) }).catch(error => { this.error = message(error); this.render(); });
	}

	private render(): void {
		if (this.exceptionControls.isDisposed) return;
		const selectedConfiguration = this.configurationsElement.value;
		this.configurationsElement.replaceChildren(...this.debug.configurations.map(configuration => option(this.element.ownerDocument, configuration.id, configuration.workspaceFolderName ? `${configuration.name} — ${configuration.workspaceFolderName}` : configuration.name)), ...this.debug.compounds.map(compound => option(this.element.ownerDocument, compound.id, `${compound.name}${compound.workspaceFolderName ? ` — ${compound.workspaceFolderName}` : ""} (compound)`)));
		if ([...this.debug.configurations, ...this.debug.compounds].some(candidate => candidate.id === selectedConfiguration)) this.configurationsElement.value = selectedConfiguration;
		const session = this.debug.session;
		this.sessionsElement.replaceChildren(...this.debug.sessions.map(candidate => option(this.element.ownerDocument, candidate.id, `${candidate.configuration.name} — ${candidate.state}`)));
		if (session) this.sessionsElement.value = session.id;
		this.sessionsElement.hidden = this.debug.sessions.length < 2;
		this.statusElement.textContent = this.error ?? (!session ? `${this.debug.configurations.length} debug configuration${this.debug.configurations.length === 1 ? "" : "s"}.` : `${session.configuration.name}: ${session.state}${session.reason ? ` (${session.reason})` : ""}`);
		this.threadsElement.replaceChildren(...this.threads.map(thread => option(this.element.ownerDocument, String(thread.id), thread.name)));
		if (session?.threadId) this.threadsElement.value = String(session.threadId);
		this.threadsElement.hidden = this.threads.length < 2;
		this.stackElement.replaceChildren(heading(this.element.ownerDocument, "Call Stack"), ...this.frames.map((frame, index) => itemButton(this.element.ownerDocument, `${frame.name}  ${frame.source?.name ?? frame.source?.path ?? ""}:${frame.lineNumber}`, "ash-debug-frame", "frameIndex", index, frame.id === this.selectedFrameId)));
		this.variablesElement.replaceChildren(heading(this.element.ownerDocument, "Variables"), ...this.variableRows.map((row, index) => variableItem(this.element.ownerDocument, row, index)));
		this.watchElement.replaceChildren(heading(this.element.ownerDocument, "Watch"), ...this.debug.watchExpressions.map((expression, index) => watchItem(this.element.ownerDocument, expression, this.watchResults.find(result => result.expression === expression), index)));
		const selectedExceptions = this.debug.exceptionBreakpoints;
		this.exceptionControls.clear();
		this.exceptionsElement.replaceChildren(heading(this.element.ownerDocument, "Exception Breakpoints"), ...(session?.capabilities.exceptionBreakpointFilters ?? []).map(filter => exceptionItem(this.exceptionControls, this.element.ownerDocument, filter.filter, filter.label, filter.description, selectedExceptions.length > 0 ? selectedExceptions.includes(filter.filter) : filter.default)));
		this.exceptionsElement.hidden = !session || session.capabilities.exceptionBreakpointFilters.length === 0;
		this.breakpointsElement.replaceChildren(heading(this.element.ownerDocument, "Breakpoints"), ...this.debug.breakpoints.map((breakpoint, index) => breakpointItem(this.element.ownerDocument, breakpoint, index)));
	}

	private scopeRow(scope: IDebugScope): DebugVariableRow { return Object.freeze({ key: ++this.variableKey, name: scope.name, variablesReference: scope.variablesReference, depth: 0, expanded: true }); }
	private variableRow(variable: IDebugVariable, depth: number): DebugVariableRow { return Object.freeze({ key: ++this.variableKey, name: variable.name, value: variable.value, variablesReference: variable.variablesReference, depth, expanded: false, ...(variable.type ? { type: variable.type } : {}) }); }
}

function button(document: Document, label: string, operation: string): HTMLButtonElement { const element = h(document, "button"); element.type = "button"; element.textContent = label; element.dataset.operation = operation; return element; }
function select(document: Document, label: string): HTMLSelectElement { const element = h(document, "select"); element.setAttribute("aria-label", label); return element; }
function option(document: Document, value: string, label: string): HTMLOptionElement { const element = h(document, "option"); element.value = value; element.textContent = label; return element; }
function section(document: Document, label: string, className: string): HTMLUListElement { const element = h(document, "ul"); element.className = `ash-debug-section ${className}`; element.setAttribute("aria-label", label); return element; }
function heading(document: Document, label: string): HTMLLIElement { const element = h(document, "li"); element.className = "ash-debug-section-heading"; element.textContent = label; return element; }
function itemButton(document: Document, label: string, className: string, dataName: string, index: number, selected = false): HTMLLIElement { const item = h(document, "li"); const action = h(document, "button"); action.type = "button"; action.className = className; action.classList.toggle("selected", selected); action.textContent = label; action.dataset[dataName] = String(index); item.append(action); return item; }
function variableItem(document: Document, row: DebugVariableRow, index: number): HTMLLIElement { const indicator = row.variablesReference > 0 ? row.expanded ? "▾ " : "▸ " : "  "; const label = `${indicator}${row.name}${row.value === undefined ? "" : ` = ${row.value}`}${row.type ? ` : ${row.type}` : ""}`; const item = itemButton(document, label, "ash-debug-variable", "variableIndex", index); const action = item.firstElementChild as HTMLButtonElement; action.style.paddingInlineStart = `${6 + row.depth * 14}px`; action.disabled = row.variablesReference <= 0 && row.value === undefined; return item; }
function watchItem(document: Document, expression: string, result: DebugWatchResult | undefined, index: number): HTMLLIElement { const item = h(document, "li"); const value = h(document, "span"); value.className = "ash-debug-watch-value"; value.textContent = `${expression}${result?.result ? ` = ${result.result.result}` : result?.error ? ` — ${result.error}` : ""}`; const remove = button(document, "Remove", "removeWatch"); remove.className = "ash-debug-watch-remove"; remove.dataset.watchIndex = String(index); item.append(value, remove); return item; }
function exceptionItem(owner: DisposableStore, document: Document, filter: string, label: string, description: string | undefined, checked: boolean): HTMLLIElement { const item = h(document, "li"); const control = owner.add(new Checkbox(item, { label, checked })); control.element.classList.add("ash-debug-exception-toggle"); control.input.dataset.exceptionFilter = filter; if (description) control.element.title = description; return item; }
function breakpointItem(document: Document, breakpoint: IDebugBreakpoint, index: number): HTMLLIElement { const item = itemButton(document, `${breakpoint.resource.path.split("/").at(-1)}:${breakpoint.lineNumber}`, "ash-debug-breakpoint", "breakpointIndex", index); const remove = button(document, "Remove", "removeBreakpoint"); remove.className = "ash-debug-breakpoint-remove"; item.append(remove); return item; }
function inputForm(document: Document, label: string, action: string): [HTMLFormElement, HTMLInputElement] { const form = h(document, "form"); form.className = "ash-debug-input-form"; const input = h(document, "input"); input.type = "text"; input.setAttribute("aria-label", label); const submit = h(document, "button"); submit.type = "submit"; submit.textContent = action; form.append(input, submit); return [form, input]; }
function indexFromEvent(event: Event, selector: string, dataName: string, document: Document): number | undefined { const target = event.target instanceof document.defaultView!.Element ? event.target.closest<HTMLElement>(selector) : null; const raw = target?.dataset[dataName]; if (raw === undefined) return undefined; const index = Number(raw); return Number.isSafeInteger(index) && index >= 0 ? index : undefined; }
function descendantEnd(rows: readonly DebugVariableRow[], index: number, depth: number): number { let end = index + 1; while (end < rows.length && rows[end]!.depth > depth) end += 1; return end; }
function lineSelection(lineNumber: number): Range { return Range.fromPositions(new Position(lineNumber, 1)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
