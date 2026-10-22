import { IViewsService } from '../../../services/views/common/viewsService.js';
import { WorkbenchViewContainerId } from '../../../common/views.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { observeElementSize, observeResize } from '../../../../base/browser/observer.js';
import { listRowHeight } from '../../../../base/common/uiSizes.js';
import { basename } from '../../../../base/common/resources.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IDebugService, type DebugBreakpoint, type IDebugBreakpoint, type IDebugBreakpointUpdate, type IFunctionBreakpoint, type IDataBreakpointOptions, type IDataBreakpoint, type IInstructionBreakpoint } from '../common/debug.js';
type BreakpointEditorState =
	| { readonly kind: "source"; readonly breakpoint: IDebugBreakpoint; }
	| { readonly kind: "function"; readonly breakpoint?: IFunctionBreakpoint; }
	| { readonly kind: "data"; readonly breakpoint: IDataBreakpoint; readonly options?: never; }
	| { readonly kind: "data"; readonly breakpoint?: undefined; readonly options: IDataBreakpointOptions; }
	| { readonly kind: "instruction"; readonly breakpoint?: IInstructionBreakpoint; readonly instructionReference: string; };

/** Breakpoints owns breakpoint editors and live exception controls, not their definitions. */
export class BreakpointsView extends ViewPane {
	private readonly exceptionsElement: HTMLUListElement;
	private readonly breakpointsElement: HTMLUListElement;
	private readonly breakpointToolbar: WorkbenchToolBar;
	private readonly breakpointItems = this._register(new DisposableMap<string, DebugBreakpointItem>());
	private readonly breakpointEditControls = this._register(new MutableDisposable<DisposableStore>());
	private breakpointEdit: { readonly id?: string; readonly form: HTMLFormElement; readonly sessionId?: string; } | undefined;
	private readonly exceptionControls = this._register(new DisposableStore());
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IDebugService private readonly debug: IDebugService,
		@IEditorService private readonly editor: IEditorService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IViewsService private readonly views: IViewsService,
		@INotificationService private readonly notifications: INotificationService) {
		super(container, { minimumBodySize: 32, ...options });
		const document = container.ownerDocument;
		this.element.classList.add('ash-debug-section');
		this.contentElement.classList.add('ash-debug-section-content');
		this.breakpointsElement = h(document, 'ul');
		this.breakpointsElement.className = 'ash-debug-list ash-debug-breakpoints';
		this.breakpointsElement.setAttribute('aria-label', localize('debug.breakpoints', 'Breakpoints'));
		this.contentElement.append(this.breakpointsElement);
		this.exceptionsElement = h(document, "ul");
		this.exceptionsElement.className = "ash-debug-list ash-debug-exceptions";
		this.exceptionsElement.setAttribute("aria-label", localize("debug.exceptions", "Exception Breakpoints"));
		this.contentElement.append(this.exceptionsElement);
		this.breakpointToolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, contextMenus, { ariaLabel: localize("debug.breakpoints", "Breakpoints") }));
		const breakpointActions = [
			{
				id: "debug.addFunctionBreakpoint",
				label: localize("debug.addFunctionBreakpoint", "Add Function Breakpoint"),
				icon: Lxicon.add,
				run: () => this.renderInputBox({ kind: "function" }),
			},
			{ id: "debug.enableAllBreakpoints", label: localize("debug.enableAllBreakpoints", "Enable All Breakpoints"), icon: Lxicon.check, run: () => this.debug.setBreakpointsEnabled(true) },
			{ id: "debug.disableAllBreakpoints", label: localize("debug.disableAllBreakpoints", "Disable All Breakpoints"), icon: Lxicon.pause, run: () => this.debug.setBreakpointsEnabled(false) },
			{ id: "debug.removeAllBreakpoints", label: localize("debug.removeAllBreakpoints", "Remove All Breakpoints"), icon: Lxicon.close, run: () => this.debug.removeAllBreakpoints() },
		];
		this.breakpointToolbar.setActions(breakpointActions.map(action => ({ ...action, tooltip: action.label, enabled: true })));

		this._register(addDisposableListener(this.exceptionsElement, 'change', () => { void this.changeExceptionBreakpoints(); }));
		this._register(debug.onDidChangeBreakpoints(() => this.render()));
		this._register(debug.onDidChangeExceptionBreakpoints(() => this.render()));
		this._register(debug.onDidChangeSession(() => this.render()));
		this._register(views.onDidChangeViewVisibility(() => this.updateSize()));
		this._register(views.onDidChangeViewContainerVisibility(() => this.updateSize()));
		this._register(observeResize([this.breakpointsElement, this.exceptionsElement], () => this.updateSize()));
		this._register(this.onDidChangeExpansionState(() => this.updateSize()));
		this.render();
	}
	private async changeExceptionBreakpoints(): Promise<void> {
		const filters = [...this.exceptionsElement.querySelectorAll<HTMLInputElement>("input[data-exception-filter]:checked")].map(input => input.dataset.exceptionFilter!).filter(Boolean);
		try { await this.debug.setExceptionBreakpoints(filters); }
		catch (error) { this.notifications.error(message(error)); this.render(); }
	}

	private editBreakpoint(breakpoint: IDebugBreakpoint): void {
		this.renderInputBox({ kind: "source", breakpoint });
	}

	private editAdditionalBreakpoint(breakpoint: Exclude<DebugBreakpoint, IDebugBreakpoint>): void {
		switch (breakpoint.kind) {
			case "function": this.renderInputBox({ kind: "function", breakpoint }); break;
			case "data": {
				this.renderInputBox({ kind: "data", breakpoint });
				break;
			}
			case "instruction": this.renderInputBox({ kind: "instruction", breakpoint, instructionReference: breakpoint.instructionReference }); break;
		}
	}

	renderInputBox(state: BreakpointEditorState | undefined): void {
		if (!state) {
			this.breakpointEdit = undefined;
			this.breakpointEditControls.clear();
			this.updateSize();
			return;
		}
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
			const input = controls.add(new InputBox(label, {
				inputBoxStyles: defaultInputBoxStyles,
				ariaLabel: title,
				presentation: "compact",
			}));
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
			this.renderInputBox(undefined);
			if (breakpoint) this.breakpointItems.get(breakpoint.id)?.focusEdit();
			else this.breakpointToolbar.focus();
		};
		controls.add(new Button(form, {
			...defaultButtonStyles,
			label: localize("debug.saveBreakpoint", "Save breakpoint"),
			type: "submit",
			presentation: "primary",
		}));
		controls.add(new Button(form, {
			...defaultButtonStyles,
			label: localize("debug.cancelBreakpoint", "Cancel breakpoint edit"),
			onClick: close,
		}));
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
		this.setCollapsed(false);
		this.breakpointsElement.before(form);
		controls.add(observeElementSize(form, () => this.updateSize()));
		this.updateSize();
		const first = inputs.values().next().value!;
		if (access) access.focus();
		else { first.focus(); first.select(); }
	}

	private render(): void {
		if (this.isDisposed) return;
		const session = this.debug.session;
		const stopped = session?.state === 'stopped';
		const selectedExceptions = this.debug.exceptionBreakpoints;
		this.exceptionControls.clear();
		this.exceptionsElement.replaceChildren(...(session?.capabilities.exceptionBreakpointFilters ?? []).map(filter => exceptionItem(this.exceptionControls, this.element.ownerDocument, filter.filter, filter.label, filter.description, selectedExceptions.includes(filter.filter))));
		const allBreakpoints: readonly DebugBreakpoint[] = [...this.debug.breakpoints, ...this.debug.functionBreakpoints, ...this.debug.dataBreakpoints, ...this.debug.instructionBreakpoints];
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
				if ("resource" in point) void this.editor.openEditor({ resource: point.resource }, { selection: lineSelection(point.lineNumber) }).catch(error => { this.notifications.error(message(error)); this.render(); });
				else this.editAdditionalBreakpoint(point);
			}, point => {
				if ("resource" in point) this.editBreakpoint(point);
				else this.editAdditionalBreakpoint(point);
			}));
			item.update(breakpoint);
			return item.domNode;
		}));
		if (focusedBreakpointControl?.isConnected) focusedBreakpointControl.focus();
		this.updateSize();
	}
	private updateSize(): void {
		const breakpoints = this;
		if (!this.contentElement.isConnected || breakpoints.isCollapsed()) return;
		// Measure intrinsic children rather than the allocated body, so removing rows can shrink it.
		const contentHeight = Math.ceil([...this.contentElement.children].reduce((height, child) => height + child.getBoundingClientRect().height, 0));
		const minimum = Math.min(contentHeight, 9 * listRowHeight);
		const container = this.views.getActiveViewPaneContainerWithId(WorkbenchViewContainerId.Debug);
		const fillSpace = container?.panes.every(pane => pane.id === this.id || !pane.isBodyVisible()) ?? false;
		const maximum = fillSpace ? Number.POSITIVE_INFINITY : contentHeight;
		// Keep the constraints valid while moving between empty, populated and filling states.
		if (minimum > breakpoints.maximumBodySize) breakpoints.maximumBodySize = maximum;
		breakpoints.minimumBodySize = minimum;
		breakpoints.maximumBodySize = maximum;
	}


}
function select(document: Document, label: string): HTMLSelectElement { const element = h(document, "select"); element.setAttribute("aria-label", label); return element; }
function option(document: Document, value: string, label: string): HTMLOptionElement { const element = h(document, "option"); element.value = value; element.textContent = label; return element; }
function exceptionItem(owner: DisposableStore, document: Document, filter: string, label: string, description: string | undefined, checked: boolean): HTMLLIElement {
	const item = h(document, "li"); const control = owner.add(new Checkbox(item, {
		...defaultCheckboxStyles,
		label,
		checked,
	})); control.element.classList.add("ash-debug-exception-toggle"); control.input.dataset.exceptionFilter = filter; if (description) control.element.title = description; return item;
}
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
			...defaultCheckboxStyles,
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
			...defaultButtonStyles,
			label: localize("debug.editBreakpoint", "Edit breakpoint"),
			icon: Lxicon.settings,
			iconOnly: true,
			size: "small",
			title: localize("debug.editBreakpoint", "Edit breakpoint"),
			onClick: () => edit(this.breakpoint),
		}));
		this._register(new Button(this.domNode, {
			...defaultButtonStyles,
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
function lineSelection(lineNumber: number): Range { return Range.fromPositions(new Position(lineNumber, 1)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
