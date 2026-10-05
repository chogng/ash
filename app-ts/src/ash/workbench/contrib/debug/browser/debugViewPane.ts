import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { getHoverDelegate, type IManagedHover } from "../../../../base/browser/ui/hover/hoverDelegate.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { Checkbox } from "../../../../base/browser/ui/toggle/toggle.js";
import { InputBox } from "../../../../base/browser/ui/inputbox/inputbox.js";
import { Pane, PaneView } from "../../../../base/browser/ui/splitview/paneview.js";
import { observeElementSize } from "../../../../base/browser/observer.js";
import { FileNotFoundError, IFileService } from "../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IWorkspaceOpenService } from "../../../services/workspaces/browser/workspaceOpenService.js";
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
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
import { DisassemblyViewInput } from '../common/disassemblyViewInput.js';
import { DISASSEMBLY_VIEW_ID } from '../common/debug.js';
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { type DebugBreakpoint, type IDebugBreakpointUpdate, type IDataBreakpointOptions, type IDataBreakpoint, type IFunctionBreakpoint, type IInstructionBreakpoint, type IDebugBreakpoint, type IDebugConfiguration, type IDebugEvaluateResult, type IDebugScope, IDebugService, type IDebugSession, type IDebugStackFrame, type IDebugThread, type IDebugVariable } from "../../../services/debug/common/debugService.js";

interface DebugVariableRow {
	readonly key: number;
	readonly name: string;
	readonly value?: string;
	readonly type?: string;
	readonly variablesReference: number;
	// DAP setVariable addresses the parent container, not the variable's children.
	readonly parentVariablesReference?: number;
	readonly readOnly?: boolean;
	readonly depth: number;
	readonly expanded: boolean;
}

interface DebugWatchResult {
	readonly expression: string;
	readonly result?: IDebugEvaluateResult;
	readonly error?: string;
}

interface VariableEdit {
	readonly row: DebugVariableRow;
	readonly session: IDebugSession;
	readonly generation: number;
	readonly input: InputBox;
	readonly form: HTMLFormElement;
	pending: boolean;
}

type DebugOperation = "start" | "continue" | "pause" | "restart" | "stepOver" | "stepInto" | "stepOut" | "stop" | "stopAll";

type BreakpointEditorState =
	| { readonly kind: "source"; readonly breakpoint: IDebugBreakpoint }
	| { readonly kind: "function"; readonly breakpoint?: IFunctionBreakpoint }
	| { readonly kind: "data"; readonly breakpoint: IDataBreakpoint; readonly options?: never }
	| { readonly kind: "data"; readonly breakpoint?: undefined; readonly options: IDataBreakpointOptions }
	| { readonly kind: "instruction"; readonly breakpoint?: IInstructionBreakpoint; readonly instructionReference: string };

/** Code Debug sidebar with multi-session inspection, recursive variables, watches, and exceptions. */
export class DebugViewPane extends ViewPane {
	private readonly paneView: PaneView;
	private readonly welcome: DebugSection;
	private readonly welcomeButton: Button;
	private readonly welcomeDescription: HTMLElement;
	private readonly controls: HTMLElement;
	private readonly configureButton: Button;
	private readonly watchToolbar: WorkbenchToolBar;
	private mountedSections: readonly DebugSection[] = [];
	private hasDebugged = false;
	private readonly startButton: Button;
	private readonly sessionToolbar: WorkbenchToolBar;
	private readonly sections: readonly DebugSection[];
	private readonly rowControls = this._register(new DisposableStore());
	private readonly variableItems = this._register(new DisposableMap<number, DebugVariableItem>());
	private readonly variableEditControls = this._register(new MutableDisposable<DisposableStore>());
	private variableEdit: VariableEdit | undefined;
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
	private readonly breakpointToolbar: WorkbenchToolBar;
	private readonly instructionToolbar: WorkbenchToolBar;
	private readonly breakpointItems = this._register(new DisposableMap<string, DebugBreakpointItem>());
	private readonly breakpointEditControls = this._register(new MutableDisposable<DisposableStore>());
	private breakpointEdit: { readonly id?: string; readonly form: HTMLFormElement; readonly sessionId?: string } | undefined;
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

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IDebugService private readonly debug: IDebugService,
		@IEditorService private readonly editor: IEditorService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceOpenService private readonly workspaceOpen: IWorkspaceOpenService,
		@IFileService private readonly files: IFileService,
	) {
		super(container, options);
		const document = container.ownerDocument;
		this.setHeaderVisible(false);
		this.contentElement.classList.add("ash-debug");
		const controls = h(document, "div");
		this.controls = controls;
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
		this.configureButton = this._register(new Button(launch, {
			label: localize("debug.configure", "Open launch.json"),
			icon: Lxicon.settings,
			iconOnly: true,
			size: "small",
			title: localize("debug.configure", "Open launch.json"),
			onClick: () => { void this.configure().catch(error => { this.error = message(error); this.render(); }); },
		}));
		this.sessionsElement = select(document, localize("debug.session", "Active debug session"));
		this.sessionToolbar = this._register(new WorkbenchToolBar(controls, contextMenus, { ariaLabel: localize("debug.controls", "Debug controls") }));
		controls.prepend(launch, this.sessionsElement);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-debug-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.threadsElement = select(document, localize("debug.thread", "Debug thread"));
		this.threadsElement.classList.add("ash-debug-thread-select");
		this.contentElement.append(controls, this.statusElement);
		this.paneView = this._register(new PaneView(this.contentElement));
		const stack = this._register(new DebugSection(this.paneView.element, "ash-debug-stack", () => localize("debug.callStack", "Call Stack"), 180));
		const variables = this._register(new DebugSection(this.paneView.element, "ash-debug-variables", () => localize("debug.variables", "Variables"), 240));
		const watch = this._register(new DebugSection(this.paneView.element, "ash-debug-watch", () => localize("debug.watch", "Watch"), 80));
		const breakpoints = this._register(new DebugSection(this.paneView.element, "ash-debug-breakpoints", () => localize("debug.breakpoints", "Breakpoints"), 120));
		this.sections = [variables, watch, stack, breakpoints];
		this.welcome = this._register(new DebugSection(this.paneView.element, "ash-debug-welcome", () => localize("debug.run", "Run"), 400));
		this.welcome.list.remove();
		this.welcome.body.classList.add("ash-debug-welcome-content");
		this.welcomeButton = this._register(new Button(this.welcome.body, {
			label: localize("debug.createLaunch", "Create a launch.json file"),
			presentation: "primary",
			onClick: () => { void this.configure().catch(error => { this.error = message(error); this.render(); }); },
		}));
		this.welcomeDescription = h(document, "p");
		this.welcome.body.append(this.welcomeDescription);
		this.stackElement = stack.list;
		this.variablesElement = variables.list;
		this.watchElement = watch.list;
		this.exceptionsElement = h(document, "ul");
		this.exceptionsElement.className = "ash-debug-list ash-debug-exceptions";
		this.exceptionsElement.setAttribute("aria-label", localize("debug.exceptions", "Exception Breakpoints"));
		breakpoints.body.append(this.exceptionsElement);
		this.breakpointsElement = breakpoints.list;
		this.breakpointToolbar = this._register(new WorkbenchToolBar(breakpoints.actions, contextMenus, { ariaLabel: localize("debug.breakpoints", "Breakpoints") }));
		const breakpointActions = [
			{
				id: "debug.addFunctionBreakpoint",
				label: localize("debug.addFunctionBreakpoint", "Add Function Breakpoint"),
				icon: Lxicon.add,
				run: () => this.showBreakpointEditor({ kind: "function" }),
			},
			{ id: "debug.enableAllBreakpoints", label: localize("debug.enableAllBreakpoints", "Enable All Breakpoints"), icon: Lxicon.check, run: () => this.debug.setBreakpointsEnabled(true) },
			{ id: "debug.disableAllBreakpoints", label: localize("debug.disableAllBreakpoints", "Disable All Breakpoints"), icon: Lxicon.pause, run: () => this.debug.setBreakpointsEnabled(false) },
			{ id: "debug.removeAllBreakpoints", label: localize("debug.removeAllBreakpoints", "Remove All Breakpoints"), icon: Lxicon.close, run: () => this.debug.removeAllBreakpoints() },
		];
		this.breakpointToolbar.setActions(breakpointActions.map(action => ({ ...action, tooltip: action.label, enabled: true })));
		this.instructionToolbar = this._register(new WorkbenchToolBar(stack.actions, contextMenus, { ariaLabel: localize("debug.callStack", "Call Stack") }));
		this.watchForm = h(document, "form");
		this.watchForm.className = "ash-debug-input-form empty";
		this.watchForm.hidden = true;
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
		watch.body.prepend(this.watchForm);
		this.watchToolbar = this._register(new WorkbenchToolBar(watch.actions, contextMenus, { ariaLabel: localize("debug.watch", "Watch") }));
		const addWatchLabel = localize("debug.addWatch", "Add watch expression");
		const removeAllWatchesLabel = localize("debug.removeAllWatches", "Remove All Expressions");
		this.watchToolbar.setActions([
			{
				id: "debug.addWatch",
				label: addWatchLabel,
				tooltip: addWatchLabel,
				enabled: true,
				icon: Lxicon.add,
				run: () => {
					watch.setCollapsed(false);
					this.watchForm.hidden = false;
					this.watchForm.classList.remove("empty");
					this.watchInput.focus();
				},
			},
			{
				id: "debug.removeAllWatches",
				label: removeAllWatchesLabel,
				tooltip: removeAllWatchesLabel,
				enabled: true,
				icon: Lxicon.close,
				run: () => {
					for (const expression of this.debug.watchExpressions) {
						this.debug.removeWatchExpression(expression);
					}
				},
			},
		]);
		stack.body.insertBefore(this.threadsElement, stack.list);
		this._register(addDisposableListener(this.watchInput, "keydown", event => {
			if (event.key === "Escape" && !event.isComposing) {
				event.preventDefault();
				this.watchInput.value = "";
				this.watchForm.hidden = true;
				this.watchForm.classList.add("empty");
				this.watchToolbar.focus();
			}
		}));
		this._register(observeElementSize(this.paneView.element, size => {
			if (size.height > 0 && size.width > 0) this.paneView.layout(size.height, size.width);
		}));
		this._register(workspace.onDidChangeWorkspace(() => this.render()));
		this._register(addDisposableListener(this.sessionsElement, "change", () => this.selectSession()));
		this._register(addDisposableListener(this.threadsElement, "change", () => { void this.selectThread(); }));
		this._register(addDisposableListener(this.stackElement, "click", event => this.activateFrame(event)));
		this._register(addDisposableListener(this.variablesElement, "click", event => {
			if (event.detail !== 2) {
				this.expandVariable(event);
			}
		}));
		this._register(addDisposableListener(this.variablesElement, "dblclick", event => this.editVariable(event)));
		this._register(addDisposableListener(this.variablesElement, "keydown", event => {
			if (event.key === "F2") this.editVariable(event);
		}));
		this._register(addDisposableListener(this.watchElement, "click", event => this.removeWatch(event)));
		this._register(addDisposableListener(this.watchForm, "submit", event => this.addWatch(event)));
		this._register(addDisposableListener(this.exceptionsElement, "change", () => { void this.changeExceptionBreakpoints(); }));
		this._register(debug.onDidChangeConfigurations(() => this.render()));
		this._register(debug.onDidChangeBreakpoints(() => this.render()));
		this._register(debug.onDidChangeWatchExpressions(() => { void this.refreshWatches().then(() => this.render()); }));
		this._register(debug.onDidChangeExceptionBreakpoints(() => this.render()));
		this._register(debug.onDidChangeSession(session => this.acceptSessionChange(session)));
		// Testing can pause a session before this view is first opened.
		this.acceptSessionChange(debug.session);
		void debug.refresh().catch(error => { this.error = message(error); this.render(); });
	}

	private async configure(): Promise<void> {
		const activeResource = this.editor.activeEditor?.resource;
		const folder = (activeResource ? this.workspace.getWorkspaceFolder(activeResource) : null) ?? this.workspace.getWorkspace().folders[0];
		if (!folder) {
			await this.workspaceOpen.openFolder();
			return;
		}
		const resource = URI.joinPath(folder.uri, ".vscode", "launch.json");
		try {
			await this.files.stat(resource);
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) throw error;
			await this.files.createDirectory(URI.joinPath(folder.uri, ".vscode"));
			await this.files.writeFileBytes(resource, new TextEncoder().encode('{\n\t"version": "0.2.0",\n\t"configurations": []\n}\n'));
		}
		await this.editor.openEditor({ resource }, { pinned: true, ignoreError: true });
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
		if (session) this.hasDebugged = true;
		this.refreshGeneration++;
		this.variableEdit = undefined;
		this.variableEditControls.clear();
		if (this.inspectedSessionId !== session?.id) {
			this.inspectedSessionId = session?.id;
			this.threads = [];
			this.frames = [];
			this.variableRows = [];
			this.watchResults = [];
			this.selectedFrameId = undefined;
		}
		if (session?.state === "stopped") void this.refreshStoppedState();
		else { this.threads = []; this.frames = []; this.variableRows = []; this.watchResults = []; this.selectedFrameId = undefined; }
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
		this.variableEdit = undefined;
		this.variableEditControls.clear();
		this.frames = [];
		this.variableRows = [];
		this.watchResults = [];
		this.selectedFrameId = undefined;
		this.error = undefined;
		this.render();
		try {
			const threads = await session.threads();
			if (!this.isCurrentInspection(session, generation)) return;
			const selectedThread = threads.find(thread => thread.id === session.threadId) ?? threads[0];
			if (!selectedThread) throw new Error(localize("debug.noThreads", "The Debug Adapter did not report any stopped threads"));
			session.selectThread(selectedThread.id);
			const frames = await session.stackTrace(selectedThread.id);
			if (!this.isCurrentInspection(session, generation)) return;
			this.threads = threads;
			this.frames = frames;
			this.selectedFrameId = frames[0]?.id;
			const frame = frames[0];
			this.debug.focusStackFrame(frame);
			const results = await Promise.allSettled([
				this.loadFrameVariables(session, frame?.id, generation),
				// Pausing while disassembly is active must keep instruction stepping in that editor.
				frame && frame.lineNumber > 0 && frame.columnNumber > 0 && this.editor.activeEditor?.editorId !== DISASSEMBLY_VIEW_ID ? this.openFrameSource(session, frame, generation) : Promise.resolve(),
			]);
			if (!this.isCurrentInspection(session, generation)) return;
			for (const result of results) {
				if (result.status === "rejected") this.error = message(result.reason);
			}
			await this.refreshWatches();
		} catch (error) {
			if (!this.isCurrentInspection(session, generation)) return;
			this.error = message(error);
		}
		if (!this.isCurrentInspection(session, generation)) return;
		this.render();
	}

	private isCurrentInspection(session: IDebugSession, generation: number): boolean {
		return !this.isDisposed && generation === this.refreshGeneration && this.debug.session === session && session.state === "stopped";
	}

	private async loadFrameVariables(session: IDebugSession, frameId: number | undefined, generation = this.refreshGeneration): Promise<void> {
		if (!this.isCurrentInspection(session, generation)) return;
		if (frameId === undefined) { this.variableRows = []; return; }
		const scopes = await session.scopes(frameId);
		if (!this.isCurrentInspection(session, generation)) return;
		const variables = await Promise.all(scopes.map(scope => scope.variablesReference > 0 ? session.variables(scope.variablesReference) : Promise.resolve(Object.freeze([]) as readonly IDebugVariable[])));
		if (!this.isCurrentInspection(session, generation) || this.selectedFrameId !== frameId) return;
		this.variableRows = Object.freeze(scopes.flatMap((scope, index) => [this.scopeRow(scope), ...variables[index]!.map(variable => this.variableRow(variable, 1, scope.variablesReference))]));
	}

	private activateFrame(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-frame", "frameIndex", this.element.ownerDocument);
		const frame = index === undefined ? undefined : this.frames[index];
		const session = this.debug.session;
		if (!frame || !session || session.state !== "stopped") return;
		const generation = ++this.refreshGeneration;
		this.variableEdit = undefined;
		this.variableEditControls.clear();
		void (async () => {
			this.selectedFrameId = frame.id;
			this.debug.focusStackFrame(frame);
			this.variableRows = [];
			this.watchResults = [];
			this.error = undefined;
			this.render();
			const results = await Promise.allSettled([
				this.openFrameSource(session, frame, generation),
				this.loadFrameVariables(session, frame.id, generation),
			]);
			if (!this.isCurrentInspection(session, generation)) return;
			for (const result of results) {
				if (result.status === "rejected") this.error = message(result.reason);
			}
			await this.refreshWatches();
			if (!this.isCurrentInspection(session, generation)) return;
			this.render();
		})().catch(error => {
			if (!this.isCurrentInspection(session, generation)) return;
			this.error = message(error);
			this.render();
		});
	}

	private async openFrameSource(session: IDebugSession, frame: IDebugStackFrame, generation: number): Promise<void> {
		if (!this.isCurrentInspection(session, generation)) return;
		const selection = frame.lineNumber > 0 && frame.columnNumber > 0 ? Range.fromPositions(new Position(frame.lineNumber, frame.columnNumber)) : undefined;
		if (frame.source?.resource) {
			await this.editor.openEditor({ resource: frame.source.resource, label: frame.source.name }, { selection });
			return;
		}
		if (frame.source?.sourceReference && frame.source.sourceReference > 0) {
			const source = await session.source(frame.source);
			if (!this.isCurrentInspection(session, generation)) return;
			const name = frame.source.name ?? `source-${frame.source.sourceReference}`;
			const resource = URI.parse(`debug-source://session/${encodeURIComponent(session.id)}/${frame.source.sourceReference}/${encodeURIComponent(name)}`);
			await this.editor.openEditor({ resource, label: name, contentType: source.mimeType, readOnly: true, initialText: source.content }, { selection });
		}
	}

	private expandVariable(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-variable", "variableIndex", this.element.ownerDocument);
		const row = index === undefined ? undefined : this.variableRows[index];
		const session = this.debug.session;
		if (!row || !session || session.state !== "stopped" || row.variablesReference <= 0 || this.variableEdit?.row.key === row.key) return;
		this.variableEdit = undefined;
		this.variableEditControls.clear();
		const generation = this.refreshGeneration;
		if (row.expanded) {
			const end = descendantEnd(this.variableRows, index!, row.depth);
			this.variableRows = Object.freeze([...this.variableRows.slice(0, index), { ...row, expanded: false }, ...this.variableRows.slice(end)]);
			this.render();
			return;
		}
		void session.variables(row.variablesReference).then(variables => {
			if (!this.isCurrentInspection(session, generation)) return;
			const currentIndex = this.variableRows.findIndex(candidate => candidate.key === row.key);
			if (currentIndex < 0 || this.variableRows[currentIndex]!.expanded) return;
			const children = variables.map(variable => this.variableRow(variable, row.depth + 1, row.variablesReference));
			this.variableRows = Object.freeze([...this.variableRows.slice(0, currentIndex), { ...row, expanded: true }, ...children, ...this.variableRows.slice(currentIndex + 1)]);
			this.render();
		}, error => {
			if (!this.isCurrentInspection(session, generation)) return;
			this.error = message(error);
			this.render();
		});
	}

	private editVariable(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-variable", "variableIndex", this.element.ownerDocument);
		const row = index === undefined ? undefined : this.variableRows[index];
		const session = this.debug.session;
		if (!row || !session || session.state !== "stopped" || !session.capabilities.supportsSetVariable || row.value === undefined || !row.parentVariablesReference || row.readOnly) return;
		event.preventDefault();
		this.variableEditControls.clear();
		const controls = new DisposableStore();
		this.variableEditControls.value = controls;
		const form = h(this.element.ownerDocument, "form");
		form.className = "ash-debug-variable-edit";
		const input = controls.add(new InputBox(form, {
			ariaLabel: localize("debug.editVariable", "Value of {0}", row.name),
			presentation: "compact",
		}));
		input.inputElement.setAttribute("aria-description", localize("debug.editVariableHelp", "Press Enter to apply the value or Escape to cancel."));
		input.value = row.value;
		const edit: VariableEdit = { row, session, generation: this.refreshGeneration, input, form, pending: false };
		this.variableEdit = edit;
		controls.add(addDisposableListener(form, "submit", event => {
			event.preventDefault();
			void this.submitVariable(edit);
		}));
		controls.add(input.onKeyDown(event => {
			if (event.key !== "Escape" || event.isComposing || edit.pending) return;
			event.preventDefault();
			event.stopPropagation();
			this.variableEdit = undefined;
			this.variableEditControls.clear();
			this.render();
			this.variablesElement.querySelector<HTMLButtonElement>(`[data-variable-key="${row.key}"]`)?.focus();
		}));
		this.render();
		input.focus();
		input.select();
	}

	private async submitVariable(edit: VariableEdit): Promise<void> {
		if (edit.pending || this.variableEdit !== edit || !this.isCurrentInspection(edit.session, edit.generation)) return;
		edit.pending = true;
		edit.input.readOnly = true;
		edit.input.showValidation("");
		try {
			const variable = await edit.session.setVariable(edit.row.parentVariablesReference!, edit.row.name, edit.input.value);
			if (this.variableEdit !== edit || !this.isCurrentInspection(edit.session, edit.generation)) return;
			const index = this.variableRows.findIndex(row => row.key === edit.row.key);
			const end = descendantEnd(this.variableRows, index, edit.row.depth);
			// The adapter may replace the child reference when assigning a new value.
			// Retire expanded children before exposing that new reference.
			this.variableRows = Object.freeze([
				...this.variableRows.slice(0, index),
				{ ...edit.row, value: variable.value, type: variable.type, variablesReference: variable.variablesReference, expanded: false },
				...this.variableRows.slice(end),
			]);
			await this.refreshWatches();
			if (this.variableEdit !== edit || !this.isCurrentInspection(edit.session, edit.generation)) return;
			this.variableEdit = undefined;
			this.variableEditControls.clear();
			this.render();
			this.variablesElement.querySelector<HTMLButtonElement>(`[data-variable-key="${edit.row.key}"]`)?.focus();
		} catch (error) {
			if (this.variableEdit !== edit || !this.isCurrentInspection(edit.session, edit.generation)) return;
			edit.pending = false;
			edit.input.readOnly = false;
			edit.input.showValidation(message(error));
			edit.input.focus();
		}
	}

	private addWatch(event: Event): void {
		event.preventDefault();
		const expression = this.watchInput.value;
		this.debug.addWatchExpression(expression);
		this.watchInput.value = "";
		this.watchForm.hidden = true;
		this.watchForm.classList.add("empty");
		this.watchToolbar.focus();
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
		const generation = this.refreshGeneration;
		const results = await Promise.all(expressions.map(async expression => {
			try { return { expression, result: await session.evaluate(expression, frameId, "watch") }; }
			catch (error) { return { expression, error: message(error) }; }
		}));
		if (!this.isCurrentInspection(session, generation) || this.selectedFrameId !== frameId || this.debug.watchExpressions !== expressions) return;
		this.watchResults = Object.freeze(results);
	}

	private async changeExceptionBreakpoints(): Promise<void> {
		const filters = [...this.exceptionsElement.querySelectorAll<HTMLInputElement>("input[data-exception-filter]:checked")].map(input => input.dataset.exceptionFilter!).filter(Boolean);
		try { await this.debug.setExceptionBreakpoints(filters); }
		catch (error) { this.error = message(error); this.render(); }
	}

	private editBreakpoint(breakpoint: IDebugBreakpoint): void {
		this.showBreakpointEditor({ kind: "source", breakpoint });
	}

	private editAdditionalBreakpoint(breakpoint: Exclude<DebugBreakpoint, IDebugBreakpoint>): void {
		switch (breakpoint.kind) {
			case "function": this.showBreakpointEditor({ kind: "function", breakpoint }); break;
			case "data": {
				this.showBreakpointEditor({ kind: "data", breakpoint });
				break;
			}
			case "instruction": this.showBreakpointEditor({ kind: "instruction", breakpoint, instructionReference: breakpoint.instructionReference }); break;
		}
	}

	private showBreakpointEditor(state: BreakpointEditorState): void {
		const breakpoint = state.breakpoint;
		this.breakpointEditControls.clear();
		const controls = new DisposableStore();
		this.breakpointEditControls.value = controls;
		const form = h(this.element.ownerDocument, "form");
		form.className = "ash-debug-breakpoint-edit";
		controls.add(toDisposable(() => form.remove()));
		form.setAttribute("aria-label", localize("debug.editBreakpoint", "Edit breakpoint"));
		const inputs = new Map<keyof IDebugBreakpointUpdate, InputBox>();
		const field = (key: keyof IDebugBreakpointUpdate, title: string, value = ""): InputBox => {
			const label = h(this.element.ownerDocument, "label");
			label.textContent = title;
			form.append(label);
			const input = controls.add(new InputBox(label, { ariaLabel: title, presentation: "compact" }));
			input.value = value;
			const capabilities = this.debug.session?.capabilities;
			const supported = key === "condition" ? capabilities?.supportsConditionalBreakpoints
				: key === "hitCondition" ? capabilities?.supportsHitConditionalBreakpoints
					: key === "logMessage" ? capabilities?.supportsLogPoints : undefined;
			if (supported === false) input.inputElement.setAttribute("aria-description", localize("debug.breakpointUnsupported", "The active debug adapter does not support this breakpoint option."));
			inputs.set(key, input);
			return input;
		};
		if (state.kind === "function") field("name", localize("debug.functionName", "Function name"), state.breakpoint?.name);
		if (state.kind === "instruction") {
			field("instructionReference", localize("debug.instructionAddress", "Instruction address"), state.instructionReference);
			field("offset", localize("debug.instructionOffset", "Instruction byte offset"), String(state.breakpoint?.offset ?? 0));
		}
		let access: HTMLSelectElement | undefined;
		if (state.kind === "data") {
			const data = state.breakpoint ?? state.options;
			const label = h(this.element.ownerDocument, "label");
			label.textContent = localize("debug.dataAccess", "Break on access");
			access = select(this.element.ownerDocument, label.textContent);
			access.append(...data.accessTypes.map(type => option(this.element.ownerDocument, type, dataAccessLabel(type))));
			access.value = data.accessType;
			label.append(access);
			form.append(label);
		}
		field("condition", localize("debug.breakpointCondition", "Expression condition"), breakpoint?.condition);
		field("hitCondition", localize("debug.breakpointHitCondition", "Hit count condition"), breakpoint?.hitCondition);
		if (state.kind === "source") field("logMessage", localize("debug.breakpointLogMessage", "Log message"), state.breakpoint.logMessage);
		const close = () => {
			this.breakpointEdit = undefined;
			form.remove();
			this.breakpointEditControls.clear();
			if (breakpoint) this.breakpointItems.get(breakpoint.id)?.focusEdit();
			else this.breakpointToolbar.focus();
		};
		controls.add(new Button(form, { label: localize("debug.saveBreakpoint", "Save breakpoint"), type: "submit", presentation: "primary" }));
		controls.add(new Button(form, { label: localize("debug.cancelBreakpoint", "Cancel breakpoint edit"), onClick: close }));
		controls.add(addDisposableListener(form, "keydown", event => {
			if (event.key === "Escape" && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		}));
		controls.add(addDisposableListener(form, "submit", event => {
			event.preventDefault();
			try {
				const update: { -readonly [K in keyof IDebugBreakpointUpdate]: IDebugBreakpointUpdate[K] } = {};
				for (const [key, input] of inputs) {
					if (key === "offset") {
						if (!/^[+-]?\d+$/.test(input.value.trim()) || !Number.isSafeInteger(Number(input.value))) {
							input.showValidation(localize("debug.invalidInstructionOffset", "Instruction byte offset must be an integer."));
							return;
						}
						update.offset = Number(input.value);
					} else if (key === "name" || key === "instructionReference" || key === "condition" || key === "hitCondition" || key === "logMessage") update[key] = input.value;
				}
				if (state.kind === "instruction" && !update.instructionReference?.trim()) {
					inputs.get("instructionReference")!.showValidation(localize("debug.instructionAddressRequired", "Enter an instruction address."));
					return;
				}
				if (access) update.accessType = access.value as IDataBreakpointOptions["accessType"];
				if (breakpoint) this.debug.updateBreakpoint(breakpoint.id, update);
				else if (state.kind === "function") {
					if (!update.name?.trim()) throw new Error(localize("debug.functionNameRequired", "Enter a function name."));
					this.debug.addFunctionBreakpoint({ name: update.name, condition: update.condition, hitCondition: update.hitCondition });
				} else if (state.kind === "data" && !state.breakpoint) this.debug.addDataBreakpoint({ ...state.options, accessType: update.accessType!, condition: update.condition, hitCondition: update.hitCondition });
				else if (state.kind === "instruction") this.debug.addInstructionBreakpoint({ instructionReference: update.instructionReference!, offset: update.offset, condition: update.condition, hitCondition: update.hitCondition });
				close();
			} catch (error) { inputs.values().next().value!.showValidation(message(error)); }
		}));
		const sessionId = state.kind === "instruction" ? this.debug.session!.id : state.kind === "data" && !state.breakpoint ? state.options.sessionId : undefined;
		this.breakpointEdit = { id: breakpoint?.id, form, sessionId };
		this.sections[3]!.setCollapsed(false);
		this.breakpointsElement.before(form);
		const first = inputs.values().next().value!;
		if (access) access.focus();
		else { first.focus(); first.select(); }
	}

	private async breakOnVariable(index: number): Promise<void> {
		const row = this.variableRows[index];
		const session = this.debug.session;
		if (!row?.parentVariablesReference || !session || session.state !== "stopped") return;
		const generation = this.refreshGeneration;
		try {
			const info = await session.dataBreakpointInfo(row.name, row.parentVariablesReference, this.selectedFrameId);
			if (!this.isCurrentInspection(session, generation)) return;
			if (info.dataId === null) throw new Error(info.description);
			const accessType = info.accessTypes.includes("write") ? "write" : info.accessTypes[0];
			if (!accessType) throw new Error(localize("debug.noDataAccess", "The adapter did not provide a supported data access type."));
			this.showBreakpointEditor({ kind: "data", options: { ...info, dataId: info.dataId, sessionId: session.id, accessType } });
		} catch (error) {
			if (!this.isCurrentInspection(session, generation)) return;
			this.error = message(error);
			this.render();
		}
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
			section.setTitle(section.label());
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
		const showInspection = hasConfigurations || active || this.hasDebugged;
		const hasFolder = this.workspace.getWorkspace().folders.length > 0;
		this.controls.hidden = !showInspection;
		this.controls.classList.toggle("empty", !showInspection);
		this.configureButton.enabled = hasFolder;
		this.welcomeButton.label = hasFolder ? localize("debug.createLaunch", "Create a launch.json file") : localize("debug.openFolder", "Open Folder");
		this.welcomeButton.enabled = hasFolder || this.workspaceOpen.canOpenFolder;
		this.welcomeDescription.textContent = hasFolder
			? localize("debug.welcomeConfigure", "To customize Run and Debug, create a launch.json file and add a debug configuration.")
			: localize("debug.welcomeOpenFolder", "To customize Run and Debug, open a folder and create a launch.json file.");
		let desiredSections: readonly DebugSection[];
		if (showInspection) {
			desiredSections = this.sections;
		} else if (this.debug.breakpoints.length + this.debug.functionBreakpoints.length + this.debug.dataBreakpoints.length + this.debug.instructionBreakpoints.length > 0) {
			desiredSections = [this.welcome, this.sections[3]!];
		} else {
			desiredSections = [this.welcome];
		}
		for (const section of this.mountedSections) {
			if (!desiredSections.includes(section)) this.paneView.removePane(section);
		}
		for (const [index, section] of desiredSections.entries()) {
			if (!this.mountedSections.includes(section)) this.paneView.addPane(section, section.initialSize, index);
		}
		this.mountedSections = desiredSections;
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
		let status = "";
		if (session) {
			status = `${session.configuration.name}: ${sessionStateLabel(session.state)}${session.reason ? ` (${session.reason})` : ""}`;
		}
		this.statusElement.textContent = this.error ?? status;
		this.statusElement.hidden = !this.statusElement.textContent;
		this.statusElement.classList.toggle("empty", !this.statusElement.textContent);
		this.threadsElement.replaceChildren(...this.threads.map(thread => option(this.element.ownerDocument, String(thread.id), thread.name)));
		if (session?.threadId) this.threadsElement.value = String(session.threadId);
		this.threadsElement.hidden = this.threads.length < 2;
		this.rowControls.clear();
		this.stackElement.replaceChildren(...this.frames.map((frame, index) => itemButton(this.rowControls, this.element.ownerDocument, `${frame.name}  ${frame.source?.name ?? frame.source?.path ?? ""}${frame.lineNumber > 0 ? `:${frame.lineNumber}` : ""}`, "ash-debug-frame", "frameIndex", index, frame.id === this.selectedFrameId)));
		const variableInputWasFocused = this.variableEdit?.input.hasFocus();
		const variableKeys = new Set(this.variableRows.map(row => row.key));
		for (const key of this.variableItems.keys()) {
			if (!variableKeys.has(key)) {
				this.variableItems.deleteAndDispose(key);
			}
		}
		this.variablesElement.replaceChildren(...this.variableRows.map((row, index) => {
			// Preserve the click target across expansion so double-click remains one gesture.
			let item = this.variableItems.get(row.key);
			if (!item) {
				item = this.variableItems.set(row.key, new DebugVariableItem(this.element.ownerDocument, index => { void this.breakOnVariable(index); }));
			}
			item.update(row, index, stopped && session.capabilities.supportsSetVariable, stopped && session.capabilities.supportsDataBreakpoints, this.variableEdit?.row.key === row.key ? this.variableEdit.form : undefined);
			return item.domNode;
		}));
		if (variableInputWasFocused) this.variableEdit?.input.focus();
		this.watchElement.replaceChildren(...this.debug.watchExpressions.map((expression, index) => watchItem(this.rowControls, this.element.ownerDocument, expression, this.watchResults.find(result => result.expression === expression), index)));
		const selectedExceptions = this.debug.exceptionBreakpoints;
		this.exceptionControls.clear();
		this.exceptionsElement.replaceChildren(...(session?.capabilities.exceptionBreakpointFilters ?? []).map(filter => exceptionItem(this.exceptionControls, this.element.ownerDocument, filter.filter, filter.label, filter.description, selectedExceptions.length > 0 ? selectedExceptions.includes(filter.filter) : filter.default)));
		const allBreakpoints: readonly DebugBreakpoint[] = [...this.debug.breakpoints, ...this.debug.functionBreakpoints, ...this.debug.dataBreakpoints, ...this.debug.instructionBreakpoints];
		const instructionLabel = localize("debug.addInstructionBreakpoint", "Add Instruction Breakpoint");
		this.instructionToolbar.setActions([{
			id: "debug.addInstructionBreakpoint",
			label: instructionLabel,
			tooltip: instructionLabel,
			icon: Lxicon.add,
			enabled: Boolean(stopped && session.capabilities.supportsInstructionBreakpoints),
			run: () => this.showBreakpointEditor({ kind: "instruction", instructionReference: this.frames.find(frame => frame.id === this.selectedFrameId)?.instructionPointerReference ?? "" }),
		}, {
			id: 'debug.action.openDisassemblyView', label: localize('debug.openDisassembly', 'Open Disassembly View'), tooltip: localize('debug.openDisassembly', 'Open Disassembly View'), icon: Lxicon.code,
			enabled: Boolean(stopped && session.capabilities.supportsDisassembleRequest),
			run: () => this.editor.openEditor(new DisassemblyViewInput(), { pinned: true }),
		}]);
		const breakpointIds = new Set(allBreakpoints.map(breakpoint => breakpoint.id));
		for (const id of this.breakpointItems.keys()) {
			if (!breakpointIds.has(id)) this.breakpointItems.deleteAndDispose(id);
		}
		const edit = this.breakpointEdit;
		if (edit && ((edit.id && !breakpointIds.has(edit.id)) || (edit.sessionId && (edit.sessionId !== session?.id || !stopped)))) {
			edit.form.remove();
			this.breakpointEdit = undefined;
			this.breakpointEditControls.clear();
		}
		const focusedBreakpointControl = this.breakpointsElement.contains(this.element.ownerDocument.activeElement) ? this.element.ownerDocument.activeElement as HTMLElement : undefined;
		this.breakpointsElement.replaceChildren(...allBreakpoints.map(breakpoint => {
			let item = this.breakpointItems.get(breakpoint.id);
			if (!item) item = this.breakpointItems.set(breakpoint.id, new DebugBreakpointItem(this.element.ownerDocument, this.debug, point => {
				if ("resource" in point) void this.editor.openEditor({ resource: point.resource }, { selection: lineSelection(point.lineNumber) }).catch(error => { this.error = message(error); this.render(); });
				else this.editAdditionalBreakpoint(point);
			}, point => {
				if ("resource" in point) this.editBreakpoint(point);
				else this.editAdditionalBreakpoint(point);
			}));
			item.update(breakpoint);
			return item.domNode;
		}));
		if (focusedBreakpointControl?.isConnected) focusedBreakpointControl.focus();
	}

	private scopeRow(scope: IDebugScope): DebugVariableRow { return Object.freeze({ key: ++this.variableKey, name: scope.name, variablesReference: scope.variablesReference, depth: 0, expanded: true }); }
	private variableRow(variable: IDebugVariable, depth: number, parentVariablesReference: number): DebugVariableRow {
		return Object.freeze({ key: ++this.variableKey, name: variable.name, value: variable.value, variablesReference: variable.variablesReference, parentVariablesReference, readOnly: variable.presentationHint?.attributes?.includes("readOnly") || variable.presentationHint?.lazy === true, depth, expanded: false, ...(variable.type ? { type: variable.type } : {}) });
	}
}

function select(document: Document, label: string): HTMLSelectElement { const element = h(document, "select"); element.setAttribute("aria-label", label); return element; }
function option(document: Document, value: string, label: string): HTMLOptionElement { const element = h(document, "option"); element.value = value; element.textContent = label; return element; }
class DebugSection extends Pane {
	public readonly list: HTMLUListElement;
	public readonly body: HTMLElement;
	public readonly actions: HTMLElement;

	constructor(container: HTMLElement, className: string, public readonly label: () => string, public readonly initialSize: number) {
		super(container, { id: className, title: label(), minimumBodySize: 32 });
		this.body = this.contentElement;
		this.actions = this.headerActionsElement;
		this.element.classList.add("ash-debug-section");
		this.body.classList.add("ash-debug-section-content");
		this.list = h(container.ownerDocument, "ul");
		this.list.className = `ash-debug-list ${className}`;
		this.list.setAttribute("aria-label", label());
		this.body.append(this.list);
		// PaneView mounts only sections needed for the current debug state.
		this.element.remove();
	}
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
class DebugVariableItem extends Disposable {
	public readonly domNode: HTMLLIElement;
	private readonly action: HTMLButtonElement;
	private readonly hover: IManagedHover;
	private readonly dataBreakpoint: Button;
	private variableIndex = 0;

	constructor(document: Document, breakOnData: (index: number) => void) {
		super();
		this.domNode = h(document, "li");
		this.action = h(document, "button");
		this.action.type = "button";
		this.action.className = "ash-debug-variable";
		this.hover = this._register(getHoverDelegate().setupHover({ target: this.action, content: "" }));
		this.dataBreakpoint = this._register(new Button(this.domNode, {
			label: localize("debug.breakOnData", "Break on data access"),
			icon: Lxicon.add,
			iconOnly: true,
			size: "small",
			title: localize("debug.breakOnData", "Break on data access"),
			onClick: () => breakOnData(this.variableIndex),
		}));
		this.dataBreakpoint.domNode.classList.add("ash-debug-variable-data");
	}

	public update(row: DebugVariableRow, index: number, supportsSetVariable: boolean, supportsDataBreakpoints: boolean, editForm: HTMLFormElement | undefined): void {
		this.variableIndex = index;
		const indicator = row.variablesReference > 0 ? row.expanded ? "▾ " : "▸ " : "  ";
		const label = `${indicator}${row.name}${row.value === undefined ? "" : ` = ${row.value}`}${row.type ? ` : ${row.type}` : ""}`;
		this.action.textContent = label;
		this.hover.update(label);
		this.action.dataset.variableIndex = String(index);
		this.action.dataset.variableKey = String(row.key);
		if (row.variablesReference > 0) {
			this.action.setAttribute("aria-expanded", String(row.expanded));
		} else {
			this.action.removeAttribute("aria-expanded");
		}
		if (supportsSetVariable && row.value !== undefined && !row.readOnly) {
			this.action.setAttribute("aria-keyshortcuts", "F2");
			this.action.setAttribute("aria-description", localize("debug.variableEditHint", "Press F2 or double-click to change the value."));
		} else {
			this.action.removeAttribute("aria-keyshortcuts");
			this.action.removeAttribute("aria-description");
		}
		this.action.style.paddingInlineStart = `${6 + row.depth * 14}px`;
		this.action.disabled = row.variablesReference <= 0 && row.value === undefined;
		const canWatch = supportsDataBreakpoints && Boolean(row.parentVariablesReference) && !editForm;
		this.dataBreakpoint.label = localize("debug.breakOnVariable", "Break on data access for {0}", row.name);
		this.dataBreakpoint.enabled = canWatch;
		this.dataBreakpoint.domNode.hidden = !canWatch;
		this.dataBreakpoint.domNode.classList.toggle("empty", !canWatch);
		this.domNode.replaceChildren(editForm ?? this.action, this.dataBreakpoint.domNode);
	}
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
class DebugBreakpointItem extends Disposable {
	public readonly domNode: HTMLLIElement;
	private readonly checkbox: Checkbox;
	private readonly action: HTMLButtonElement;
	private readonly edit: Button;
	private breakpoint!: DebugBreakpoint;

	constructor(document: Document, debug: IDebugService, open: (breakpoint: DebugBreakpoint) => void, edit: (breakpoint: DebugBreakpoint) => void) {
		super();
		this.domNode = h(document, "li");
		this.checkbox = this._register(new Checkbox(this.domNode, {
			onChange: enabled => debug.updateBreakpoint(this.breakpoint.id, { enabled }),
		}));
		this.action = h(document, "button");
		this.action.type = "button";
		this.action.className = "ash-debug-breakpoint";
		this.domNode.append(this.action);
		this._register(addDisposableListener(this.action, "click", () => open(this.breakpoint)));
		this._register(addDisposableListener(this.action, "keydown", event => {
			if (event.key === "F2") {
				event.preventDefault();
				edit(this.breakpoint);
			}
		}));
		this.edit = this._register(new Button(this.domNode, {
			label: localize("debug.editBreakpoint", "Edit breakpoint"),
			icon: Lxicon.settings,
			iconOnly: true,
			size: "small",
			title: localize("debug.editBreakpoint", "Edit breakpoint"),
			onClick: () => edit(this.breakpoint),
		}));
		this._register(new Button(this.domNode, {
			label: localize("debug.removeBreakpoint", "Remove breakpoint"),
			icon: Lxicon.close,
			iconOnly: true,
			size: "small",
			title: localize("debug.removeBreakpoint", "Remove breakpoint"),
			onClick: () => debug.removeBreakpoint(this.breakpoint.id),
		}));
	}

	public update(breakpoint: DebugBreakpoint): void {
		this.breakpoint = breakpoint;
		let location: string;
		if ("resource" in breakpoint) location = `${basename(breakpoint.resource)}:${breakpoint.lineNumber}`;
		else if (breakpoint.kind === "function") location = localize("debug.functionBreakpointLabel", "Function: {0}", breakpoint.name);
		else if (breakpoint.kind === "data") location = localize("debug.dataBreakpointLabel", "Data: {0} ({1})", breakpoint.description, dataAccessLabel(breakpoint.accessType));
		else location = localize("debug.instructionBreakpointLabel", "Instruction: {0} (offset {1})", breakpoint.instructionReference, breakpoint.offset ?? 0);
		this.domNode.dataset.breakpointId = breakpoint.id;
		this.domNode.dataset.breakpointKind = "resource" in breakpoint ? "source" : breakpoint.kind;
		this.domNode.classList.toggle("disabled", !breakpoint.enabled);
		this.domNode.classList.toggle("unverified", !breakpoint.verified);
		this.checkbox.checked = breakpoint.enabled;
		this.checkbox.input.setAttribute("aria-label", localize("debug.enableBreakpoint", "Enable breakpoint at {0}", location));
		const details = [breakpoint.condition, breakpoint.hitCondition, "resource" in breakpoint ? breakpoint.logMessage : undefined].filter(Boolean).join("; ");
		this.action.textContent = `${location}${details ? ` — ${details}` : ""}`;
		this.action.title = ["resource" in breakpoint ? breakpoint.resource.toString() : location, details, breakpoint.message].filter(Boolean).join("\n");
		if (breakpoint.message) this.action.setAttribute("aria-description", breakpoint.message);
		else this.action.removeAttribute("aria-description");
	}

	public focusEdit(): void { this.edit.domNode.focus(); }
}
function dataAccessLabel(type: IDataBreakpointOptions["accessType"]): string {
	switch (type) {
		case "read": return localize("debug.dataRead", "Read");
		case "write": return localize("debug.dataWrite", "Write");
		case "readWrite": return localize("debug.dataReadWrite", "Read and write");
	}
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
