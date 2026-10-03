import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { getHoverDelegate } from "../../../../base/browser/ui/hover/hoverDelegate.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { Checkbox } from "../../../../base/browser/ui/toggle/toggle.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import type { IAction } from "../../../../base/common/actions.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { localize } from "../../../../nls.js";
import { WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { basename } from "../../../../base/common/resources.js";
import { URI } from "../../../../base/common/uri.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { type IDebugBreakpoint, type IDebugConfiguration, type IDebugEvaluateResult, type IDebugScope, IDebugService, type IDebugSession, type IDebugStackFrame, type IDebugThread, type IDebugVariable } from "../../../services/debug/common/debugService.js";

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

type DebugOperation = "start" | "continue" | "pause" | "restart" | "stepOver" | "stepInto" | "stepOut" | "stop" | "stopAll";

interface DebugSection {
	readonly domNode: HTMLDetailsElement;
	readonly summary: HTMLElement;
	readonly list: HTMLUListElement;
	readonly label: () => string;
}

/** Code Debug sidebar with multi-session inspection, recursive variables, watches, and exceptions. */
export class DebugViewPane extends ViewPane {
	private readonly startButton: Button;
	private readonly sessionToolbar: WorkbenchToolBar;
	private readonly sections: readonly DebugSection[];
	private readonly exceptionSection: DebugSection;
	private readonly rowControls = this._register(new DisposableStore());
	private readonly addWatchButton: Button;
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

	constructor(container: HTMLElement, options: IViewPaneOptions, @IDebugService private readonly debug: IDebugService, @IEditorService private readonly editor: IEditorService, @IContextMenuService contextMenus: IContextMenuService) {
		super(container, options);
		const document = container.ownerDocument;
		this.setHeaderVisible(false);
		this.contentElement.classList.add("ash-debug");
		const controls = h(document, "div");
		controls.className = "ash-debug-controls";
		const launch = h(document, "div");
		launch.className = "ash-debug-launch";
		this.startButton = this._register(new Button(launch, {
			label: localize("debug.start", "Start Debugging"),
			icon: Lxicon.start,
			iconOnly: true,
			title: localize("debug.start", "Start Debugging"),
			onClick: () => this.control("start"),
		}));
		this.configurationsElement = select(document, localize("debug.configuration", "Debug configuration"));
		launch.append(this.configurationsElement);
		this.sessionsElement = select(document, localize("debug.session", "Active debug session"));
		this.sessionToolbar = this._register(new WorkbenchToolBar(controls, contextMenus, { ariaLabel: localize("debug.controls", "Debug controls") }));
		controls.prepend(launch, this.sessionsElement);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-debug-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.threadsElement = select(document, localize("debug.thread", "Debug thread"));
		this.threadsElement.classList.add("ash-debug-thread-select");
		const stack = section(document, () => localize("debug.callStack", "Call Stack"), "ash-debug-stack");
		const variables = section(document, () => localize("debug.variables", "Variables"), "ash-debug-variables");
		const watch = section(document, () => localize("debug.watch", "Watch"), "ash-debug-watch");
		this.exceptionSection = section(document, () => localize("debug.exceptions", "Exception Breakpoints"), "ash-debug-exceptions");
		const breakpoints = section(document, () => localize("debug.breakpoints", "Breakpoints"), "ash-debug-breakpoints");
		this.sections = [variables, watch, stack, breakpoints, this.exceptionSection];
		this.stackElement = stack.list;
		this.variablesElement = variables.list;
		this.watchElement = watch.list;
		this.exceptionsElement = this.exceptionSection.list;
		this.breakpointsElement = breakpoints.list;
		this.watchForm = h(document, "form");
		this.watchForm.className = "ash-debug-input-form";
		this.watchInput = h(document, "input");
		this.watchInput.type = "text";
		this.watchForm.append(this.watchInput);
		this.addWatchButton = this._register(new Button(this.watchForm, {
			label: localize("debug.addWatch", "Add watch expression"),
			icon: Lxicon.add,
			iconOnly: true,
			type: "submit",
			title: localize("debug.addWatch", "Add watch expression"),
		}));
		watch.domNode.append(this.watchForm);
		stack.domNode.insertBefore(this.threadsElement, stack.list);
		this.contentElement.append(controls, this.statusElement, ...this.sections.map(section => section.domNode));
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
		// Testing can pause a session before this view is first opened.
		this.acceptSessionChange(debug.session);
		void debug.refresh().catch(error => { this.error = message(error); this.render(); });
	}

	private control(operation: DebugOperation): void {
		this.error = undefined;
		const session = this.debug.session;
		let action: Promise<unknown>;
		switch (operation) {
			case "start": action = this.startSelected(); break;
			case "restart": action = this.debug.restart(); break;
			case "stop": action = this.debug.stop(); break;
			case "stopAll": action = this.debug.stopAll(); break;
			default: action = session![operation](); break;
		}
		void action.catch(error => { this.error = message(error); this.render(); });
	}

	private debugAction(operation: DebugOperation, label: string, icon: IAction["icon"], enabled = true): IAction {
		return { id: `ash.debug.${operation}`, label, tooltip: label, icon, enabled, run: () => this.control(operation) };
	}

	private async startSelected(): Promise<void> {
		const configuration = this.debug.configurations.find(candidate => candidate.id === this.configurationsElement.value);
		const compound = this.debug.compounds.find(candidate => candidate.id === this.configurationsElement.value);
		if (!configuration && !compound) throw new Error(localize("debug.noConfiguration", "No debug configuration found in .vscode/launch.json"));
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
			if (!selectedThread) throw new Error(localize("debug.noThreads", "The Debug Adapter did not report any stopped threads"));
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
		const selection = frame.lineNumber > 0 && frame.columnNumber > 0 ? Range.fromPositions(new Position(frame.lineNumber, frame.columnNumber)) : undefined;
		if (frame.source?.resource) {
			await this.editor.openEditor({ resource: frame.source.resource, label: frame.source.name }, { selection });
			return;
		}
		if (frame.source?.sourceReference && frame.source.sourceReference > 0) {
			const source = await session.source(frame.source);
			const name = frame.source.name ?? `source-${frame.source.sourceReference}`;
			const resource = URI.parse(`debug-source://session/${encodeURIComponent(session.id)}/${frame.source.sourceReference}/${encodeURIComponent(name)}`);
			await this.editor.openEditor({ resource, label: name, contentType: source.mimeType, readOnly: true, initialText: source.content }, { selection });
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
		const index = indexFromEvent(event, ".ash-debug-breakpoint, .ash-debug-breakpoint-remove", "breakpointIndex", this.element.ownerDocument);
		const breakpoint = index === undefined ? undefined : this.debug.breakpoints[index];
		const remove = event.target instanceof this.element.ownerDocument.defaultView!.Element && Boolean(event.target.closest(".ash-debug-breakpoint-remove"));
		if (!breakpoint) return;
		if (remove) this.debug.removeBreakpoint(breakpoint.id);
		else void this.editor.openEditor({ resource: breakpoint.resource }, { selection: lineSelection(breakpoint.lineNumber) }).catch(error => { this.error = message(error); this.render(); });
	}

	private render(): void {
		if (this.exceptionControls.isDisposed) return;
		const selectedConfiguration = this.configurationsElement.value;
		this.configurationsElement.setAttribute("aria-label", localize("debug.configuration", "Debug configuration"));
		this.sessionsElement.setAttribute("aria-label", localize("debug.session", "Active debug session"));
		this.threadsElement.setAttribute("aria-label", localize("debug.thread", "Debug thread"));
		this.watchInput.setAttribute("aria-label", localize("debug.addWatch", "Add watch expression"));
		this.watchInput.placeholder = localize("debug.watchPlaceholder", "Expression to watch");
		this.addWatchButton.label = localize("debug.addWatch", "Add watch expression");
		this.addWatchButton.setTitle(this.addWatchButton.label);
		this.startButton.label = localize("debug.start", "Start Debugging");
		this.startButton.setTitle(this.startButton.label);
		for (const section of this.sections) {
			section.summary.textContent = section.label();
			section.list.setAttribute("aria-label", section.label());
		}
		this.configurationsElement.replaceChildren(...this.debug.configurations.map(configuration => option(this.element.ownerDocument, configuration.id, configuration.workspaceFolderName ? `${configuration.name} — ${configuration.workspaceFolderName}` : configuration.name)), ...this.debug.compounds.map(compound => option(this.element.ownerDocument, compound.id, localize("debug.compound", "{0} (compound)", `${compound.name}${compound.workspaceFolderName ? ` — ${compound.workspaceFolderName}` : ""}`))));
		if ([...this.debug.configurations, ...this.debug.compounds].some(candidate => candidate.id === selectedConfiguration)) this.configurationsElement.value = selectedConfiguration;
		const hasConfigurations = this.debug.configurations.length + this.debug.compounds.length > 0;
		if (!hasConfigurations) {
			this.configurationsElement.append(option(this.element.ownerDocument, "", localize("debug.noConfigurations", "No debug configurations")));
		}
		this.configurationsElement.disabled = !hasConfigurations;
		this.startButton.enabled = hasConfigurations && this.debug.session?.state !== "starting";
		const session = this.debug.session;
		const active = session !== undefined && session.state !== "terminated" && session.state !== "error";
		const stopped = session?.state === "stopped";
		this.sessionToolbar.element.hidden = !active;
		this.sessionToolbar.element.classList.toggle("empty", !active);
		this.sessionToolbar.element.setAttribute("aria-label", localize("debug.controls", "Debug controls"));
		this.sessionToolbar.setActions(active ? [
			stopped ? this.debugAction("continue", localize("debug.continue", "Continue"), Lxicon.start) : this.debugAction("pause", localize("debug.pause", "Pause"), Lxicon.pause, session.state === "running"),
			this.debugAction("stepOver", localize("debug.stepOver", "Step Over"), Lxicon.arrowRight, stopped),
			this.debugAction("stepInto", localize("debug.stepInto", "Step Into"), Lxicon.arrowDown, stopped),
			this.debugAction("stepOut", localize("debug.stepOut", "Step Out"), Lxicon.arrowUp, stopped),
			this.debugAction("restart", localize("debug.restart", "Restart"), Lxicon.refresh, session.state !== "starting"),
			this.debugAction("stop", localize("debug.stop", "Stop"), Lxicon.square),
		] : [], this.debug.sessions.length > 1 ? [this.debugAction("stopAll", localize("debug.stopAll", "Stop All"), Lxicon.square)] : []);
		this.sessionsElement.replaceChildren(...this.debug.sessions.map(candidate => option(this.element.ownerDocument, candidate.id, `${candidate.configuration.name} — ${sessionStateLabel(candidate.state)}`)));
		if (session) this.sessionsElement.value = session.id;
		this.sessionsElement.hidden = this.debug.sessions.length < 2;
		this.statusElement.classList.toggle("error", this.error !== undefined);
		let status = hasConfigurations ? localize("debug.ready", "Select a configuration to start debugging.") : localize("debug.configureLaunch", "Add a debug configuration in .vscode/launch.json to get started.");
		if (session) {
			status = `${session.configuration.name}: ${sessionStateLabel(session.state)}${session.reason ? ` (${session.reason})` : ""}`;
		}
		this.statusElement.textContent = this.error ?? status;
		this.threadsElement.replaceChildren(...this.threads.map(thread => option(this.element.ownerDocument, String(thread.id), thread.name)));
		if (session?.threadId) this.threadsElement.value = String(session.threadId);
		this.threadsElement.hidden = this.threads.length < 2;
		this.rowControls.clear();
		this.stackElement.replaceChildren(...this.frames.map((frame, index) => itemButton(this.rowControls, this.element.ownerDocument, `${frame.name}  ${frame.source?.name ?? frame.source?.path ?? ""}${frame.lineNumber > 0 ? `:${frame.lineNumber}` : ""}`, "ash-debug-frame", "frameIndex", index, frame.id === this.selectedFrameId)));
		this.variablesElement.replaceChildren(...this.variableRows.map((row, index) => variableItem(this.rowControls, this.element.ownerDocument, row, index)));
		this.watchElement.replaceChildren(...this.debug.watchExpressions.map((expression, index) => watchItem(this.rowControls, this.element.ownerDocument, expression, this.watchResults.find(result => result.expression === expression), index)));
		const selectedExceptions = this.debug.exceptionBreakpoints;
		this.exceptionControls.clear();
		this.exceptionsElement.replaceChildren(...(session?.capabilities.exceptionBreakpointFilters ?? []).map(filter => exceptionItem(this.exceptionControls, this.element.ownerDocument, filter.filter, filter.label, filter.description, selectedExceptions.length > 0 ? selectedExceptions.includes(filter.filter) : filter.default)));
		const noExceptions = !session || session.capabilities.exceptionBreakpointFilters.length === 0;
		this.exceptionSection.domNode.hidden = noExceptions;
		this.exceptionSection.domNode.classList.toggle("empty", noExceptions);
		this.breakpointsElement.replaceChildren(...this.debug.breakpoints.map((breakpoint, index) => breakpointItem(this.rowControls, this.element.ownerDocument, breakpoint, index)));
		for (const [list, label] of [
			[this.variablesElement, localize("debug.emptyVariables", "Variables appear when execution pauses.")],
			[this.watchElement, localize("debug.emptyWatch", "Add an expression to watch its value.")],
			[this.stackElement, localize("debug.emptyStack", "The call stack appears when execution pauses.")],
			[this.breakpointsElement, localize("debug.emptyBreakpoints", "Click the editor gutter to add a breakpoint.")],
		] as const) {
			if (list.childElementCount === 0) {
				const empty = h(this.element.ownerDocument, "li");
				empty.className = "ash-debug-empty";
				empty.textContent = label;
				list.append(empty);
			}
		}
	}

	private scopeRow(scope: IDebugScope): DebugVariableRow { return Object.freeze({ key: ++this.variableKey, name: scope.name, variablesReference: scope.variablesReference, depth: 0, expanded: true }); }
	private variableRow(variable: IDebugVariable, depth: number): DebugVariableRow { return Object.freeze({ key: ++this.variableKey, name: variable.name, value: variable.value, variablesReference: variable.variablesReference, depth, expanded: false, ...(variable.type ? { type: variable.type } : {}) }); }
}

function select(document: Document, label: string): HTMLSelectElement { const element = h(document, "select"); element.setAttribute("aria-label", label); return element; }
function option(document: Document, value: string, label: string): HTMLOptionElement { const element = h(document, "option"); element.value = value; element.textContent = label; return element; }
function section(document: Document, label: () => string, className: string): DebugSection {
	const domNode = h(document, "details");
	domNode.className = "ash-debug-section";
	domNode.open = true;
	const summary = h(document, "summary");
	summary.textContent = label();
	const list = h(document, "ul");
	list.className = `ash-debug-list ${className}`;
	list.setAttribute("aria-label", label());
	domNode.append(summary, list);
	return { domNode, summary, list, label };
}
function itemButton(owner: DisposableStore, document: Document, label: string, className: string, dataName: string, index: number, selected = false): HTMLLIElement {
	const item = h(document, "li");
	const action = h(document, "button");
	action.type = "button";
	action.className = className;
	action.classList.toggle("selected", selected);
	action.textContent = label;
	action.dataset[dataName] = String(index);
	owner.add(getHoverDelegate().setupHover({ target: action, content: label }));
	item.append(action);
	return item;
}
function variableItem(owner: DisposableStore, document: Document, row: DebugVariableRow, index: number): HTMLLIElement {
	const indicator = row.variablesReference > 0 ? row.expanded ? "▾ " : "▸ " : "  ";
	const label = `${indicator}${row.name}${row.value === undefined ? "" : ` = ${row.value}`}${row.type ? ` : ${row.type}` : ""}`;
	const item = itemButton(owner, document, label, "ash-debug-variable", "variableIndex", index);
	const action = item.firstElementChild as HTMLButtonElement;
	action.style.paddingInlineStart = `${6 + row.depth * 14}px`;
	action.disabled = row.variablesReference <= 0 && row.value === undefined;
	return item;
}
function watchItem(owner: DisposableStore, document: Document, expression: string, result: DebugWatchResult | undefined, index: number): HTMLLIElement {
	const item = h(document, "li");
	const value = h(document, "span");
	value.className = "ash-debug-watch-value";
	value.textContent = `${expression}${result?.result ? ` = ${result.result.result}` : result?.error ? ` — ${result.error}` : ""}`;
	owner.add(getHoverDelegate().setupHover({ target: value, content: value.textContent }));
	item.append(value);
	const remove = owner.add(new Button(item, {
		label: localize("debug.removeWatch", "Remove watch expression"),
		icon: Lxicon.close,
		iconOnly: true,
		size: "small",
		title: localize("debug.removeWatch", "Remove watch expression"),
	})).domNode;
	remove.classList.add("ash-debug-watch-remove");
	remove.dataset.watchIndex = String(index);
	return item;
}
function exceptionItem(owner: DisposableStore, document: Document, filter: string, label: string, description: string | undefined, checked: boolean): HTMLLIElement { const item = h(document, "li"); const control = owner.add(new Checkbox(item, { label, checked })); control.element.classList.add("ash-debug-exception-toggle"); control.input.dataset.exceptionFilter = filter; if (description) control.element.title = description; return item; }
function breakpointItem(owner: DisposableStore, document: Document, breakpoint: IDebugBreakpoint, index: number): HTMLLIElement {
	const item = itemButton(owner, document, `${basename(breakpoint.resource)}:${breakpoint.lineNumber}`, "ash-debug-breakpoint", "breakpointIndex", index);
	const remove = owner.add(new Button(item, {
		label: localize("debug.removeBreakpoint", "Remove breakpoint"),
		icon: Lxicon.close,
		iconOnly: true,
		size: "small",
		title: localize("debug.removeBreakpoint", "Remove breakpoint"),
	})).domNode;
	remove.classList.add("ash-debug-breakpoint-remove");
	remove.dataset.breakpointIndex = String(index);
	return item;
}
function indexFromEvent(event: Event, selector: string, dataName: string, document: Document): number | undefined { const target = event.target instanceof document.defaultView!.Element ? event.target.closest<HTMLElement>(selector) : null; const raw = target?.dataset[dataName]; if (raw === undefined) return undefined; const index = Number(raw); return Number.isSafeInteger(index) && index >= 0 ? index : undefined; }
function descendantEnd(rows: readonly DebugVariableRow[], index: number, depth: number): number { let end = index + 1; while (end < rows.length && rows[end]!.depth > depth) end += 1; return end; }
function lineSelection(lineNumber: number): Range { return Range.fromPositions(new Position(lineNumber, 1)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function sessionStateLabel(state: IDebugSession["state"]): string {
	switch (state) {
		case "starting": return localize("debug.state.starting", "starting");
		case "running": return localize("debug.state.running", "running");
		case "stopped": return localize("debug.state.stopped", "stopped");
		case "terminated": return localize("debug.state.terminated", "terminated");
		case "error": return localize("debug.state.error", "error");
	}
}
