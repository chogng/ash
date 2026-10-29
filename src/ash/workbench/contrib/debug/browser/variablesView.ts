import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ADD_DATA_BREAKPOINT_ID } from './debugCommands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { getHoverDelegate, type IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IDebugService, type IDebugSession, type IDebugScope, type IDebugVariable } from '../common/debug.js';

interface DebugVariableRow {
	readonly key: number;
	readonly name: string;
	readonly path: readonly string[];
	readonly value?: string;
	readonly memoryReference?: string;
	readonly type?: string;
	readonly variablesReference: number;
	// DAP setVariable addresses the parent container, not the variable's children.
	readonly parentVariablesReference?: number;
	readonly readOnly?: boolean;
	readonly depth: number;
	readonly expanded: boolean;
}

interface VariableEdit {
	readonly row: DebugVariableRow;
	readonly session: IDebugSession;
	readonly generation: number;
	readonly input: InputBox;
	readonly form: HTMLFormElement;
	pending: boolean;
}

/** Variables owns expansion, pending assignments and their frame-scoped lifetime. */
export class VariablesView extends ViewPane {
	private readonly loadingProgress = this._register(new DisposableStore());
	private readonly variablesElement: HTMLUListElement;
	private readonly variableItems = this._register(new DisposableMap<number, DebugVariableItem>());
	private readonly variableEditControls = this._register(new MutableDisposable<DisposableStore>());
	private variableEdit: VariableEdit | undefined;
	private variableRows: readonly DebugVariableRow[] = [];
	// Keep the last 32 frame presentations per live session. Only paths survive
	// a pause; DAP references must come from the new inspection.
	private readonly expandedFrames = new Map<IDebugSession, Map<number, ReadonlySet<string>>>();
	private renderedFrame: { readonly session: IDebugSession; readonly id: number; } | undefined;
	private variableKey = 0;
	private refreshGeneration = 0;
	private get selectedFrameId(): number | undefined { return this.debug.getViewModel().focusedStackFrame?.id; }
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IDebugService private readonly debug: IDebugService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService) {
		super(container, { minimumBodySize: 32, ...options });
		this.element.classList.add('ash-debug-section');
		this.contentElement.classList.add('ash-debug-section-content');
		this.variablesElement = h(container.ownerDocument, 'ul');
		this.variablesElement.className = 'ash-debug-list ash-debug-variables';
		this.variablesElement.setAttribute('aria-label', localize('debug.variables', 'Variables'));
		this.contentElement.append(this.variablesElement);
		this._register(addDisposableListener(this.variablesElement, 'click', event => { if (event.detail !== 2) this.expandVariable(event); }));
		this._register(addDisposableListener(this.variablesElement, 'dblclick', event => this.editVariable(event)));
		this._register(addDisposableListener(this.variablesElement, 'keydown', event => { if (event.key === 'F2') this.editVariable(event); }));
		this._register(debug.onDidChangeSession(() => this.refresh()));
		this._register(debug.getViewModel().onDidFocusStackFrame(() => this.refresh()));
		this.refresh();
	}
	private refresh(): void {
		this.loadingProgress.clear();
		const generation = ++this.refreshGeneration;
		this.saveExpansion();
		this.renderedFrame = undefined;
		this.variableEdit = undefined;
		this.variableEditControls.clear();
		this.variableRows = [];
		this.render();
		const session = this.debug.session;
		if (!session || session.state !== 'stopped') return;
		void this.loadFrameVariables(session, this.selectedFrameId, generation).then(() => {
			if (this.isCurrentInspection(session, generation)) this.render();
		}, error => { if (this.isCurrentInspection(session, generation)) this.notifications.error(message(error)); });
	}
	private isCurrentInspection(session: IDebugSession, generation: number): boolean {
		return !this.isDisposed && generation === this.refreshGeneration && this.debug.session === session && session.state === 'stopped';
	}
	private saveExpansion(): void {
		if (this.renderedFrame) {
			const { session, id } = this.renderedFrame;
			let frames = this.expandedFrames.get(session);
			if (!frames) this.expandedFrames.set(session, frames = new Map());
			frames.delete(id);
			frames.set(id, new Set(this.variableRows.filter(row => row.expanded).map(row => JSON.stringify(row.path))));
			if (frames.size > 32) frames.delete(frames.keys().next().value!);
		}
		for (const session of this.expandedFrames.keys()) {
			if (!this.debug.sessions.includes(session) || session.state === 'terminated' || session.state === 'error') this.expandedFrames.delete(session);
		}
	}

	private async loadFrameVariables(session: IDebugSession, frameId: number | undefined, generation = this.refreshGeneration): Promise<void> {
		if (!this.isCurrentInspection(session, generation)) return;
		if (frameId === undefined) { this.variableRows = []; return; }
		const progress = this.getProgressIndicator().show(true, 150);
		const handle = this.loadingProgress.add(toDisposable(() => progress.done()));
		using progressLifetime = toDisposable(() => { this.loadingProgress.delete(handle); handle.dispose(); });
		const scopes = await session.inspectFrame(frameId);
		if (!this.isCurrentInspection(session, generation) || this.selectedFrameId !== frameId) return;
		const saved = this.expandedFrames.get(session)?.get(frameId);
		const expanded = saved ?? new Set<string>();
		const rows = await Promise.all(scopes.map(async entry => {
			const show = saved ? saved.has(JSON.stringify([entry.scope.name])) : entry.variablesLoaded;
			const row = this.scopeRow(entry.scope, show);
			const variables = show && !entry.variablesLoaded ? await session.variables(row.variablesReference) : entry.variables;
			return this.restoreChildren(session, row, variables, expanded, generation);
		}));
		if (!this.isCurrentInspection(session, generation) || this.selectedFrameId !== frameId) return;
		this.variableRows = Object.freeze(rows.flat());
		this.renderedFrame = { session, id: frameId };
		const failed = scopes.find(entry => entry.error);
		if (failed) this.notifications.error(failed.error!);

	}
	private async restoreChildren(
		session: IDebugSession,
		row: DebugVariableRow,
		variables: readonly IDebugVariable[],
		expanded: ReadonlySet<string>,
		generation: number,
	): Promise<DebugVariableRow[]> {
		if (!row.expanded) return [row];
		const children = await Promise.all(variables.map(async variable => {
			const child = this.variableRow(variable, row.depth + 1, row.variablesReference, row.path);
			if (child.variablesReference <= 0 || !expanded.has(JSON.stringify(child.path))) return [child];
			try {
				const values = await session.variables(child.variablesReference);
				if (!this.isCurrentInspection(session, generation)) return [];
				return this.restoreChildren(session, { ...child, expanded: true }, values, expanded, generation);
			} catch (error) {
				if (this.isCurrentInspection(session, generation)) this.notifications.error(message(error));
				return [child];
			}
		}));
		return [row, ...children.flat()];
	}

	private expandVariable(event: Event): void {
		const index = indexFromEvent(event, '.ash-debug-variable', 'variableIndex', this.element.ownerDocument);
		const row = index === undefined ? undefined : this.variableRows[index];
		const session = this.debug.session;
		if (!row || !session || session.state !== 'stopped' || row.variablesReference <= 0 || this.variableEdit?.row.key === row.key) return;
		this.variableEdit = undefined;
		this.variableEditControls.clear();
		const generation = this.refreshGeneration;
		if (row.expanded) {
			const end = descendantEnd(this.variableRows, index!, row.depth);
			this.variableRows = Object.freeze([...this.variableRows.slice(0, index), { ...row, expanded: false }, ...this.variableRows.slice(end)]);
			this.render();
			return;
		}
		const loading = session.variables(row.variablesReference);
		const progress = this.getProgressIndicator().show(true, 150);
		const handle = this.loadingProgress.add(toDisposable(() => progress.done()));
		const finish = (): void => { this.loadingProgress.delete(handle); handle.dispose(); };
		void loading.then(finish, finish);
		void loading.then(variables => {
			if (!this.isCurrentInspection(session, generation)) return;
			const currentIndex = this.variableRows.findIndex(candidate => candidate.key === row.key);
			if (currentIndex < 0 || this.variableRows[currentIndex]!.expanded) return;
			const children = variables.map(variable => this.variableRow(variable, row.depth + 1, row.variablesReference, row.path));
			this.variableRows = Object.freeze([...this.variableRows.slice(0, currentIndex), { ...row, expanded: true }, ...children, ...this.variableRows.slice(currentIndex + 1)]);
			this.render();
		}, error => {
			if (!this.isCurrentInspection(session, generation)) return;
			this.notifications.error(message(error));
			this.render();
		});
	}

	private editVariable(event: Event): void {
		const index = indexFromEvent(event, '.ash-debug-variable', 'variableIndex', this.element.ownerDocument);
		const row = index === undefined ? undefined : this.variableRows[index];
		const session = this.debug.session;
		if (!row || !session || session.state !== 'stopped' || !session.capabilities.supportsSetVariable || row.value === undefined || !row.parentVariablesReference || row.readOnly) return;
		event.preventDefault();
		this.variableEditControls.clear();
		const controls = new DisposableStore();
		this.variableEditControls.value = controls;
		const form = h(this.element.ownerDocument, 'form');
		form.className = 'ash-debug-variable-edit';
		const input = controls.add(new InputBox(form, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('debug.editVariable', 'Value of {0}', row.name),
			presentation: 'compact',
		}));
		input.inputElement.setAttribute('aria-description', localize('debug.editVariableHelp', 'Press Enter to apply the value or Escape to cancel.'));
		input.value = row.value;
		const edit: VariableEdit = { row, session, generation: this.refreshGeneration, input, form, pending: false };
		this.variableEdit = edit;
		controls.add(addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			void this.submitVariable(edit);
		}));
		controls.add(input.onKeyDown(event => {
			if (event.key !== 'Escape' || event.isComposing || edit.pending) return;
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
		edit.input.showValidation('');
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
			this.debug.getViewModel().updateViews();
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

	private async breakOnVariable(index: number): Promise<void> {
		const row = this.variableRows[index];
		const session = this.debug.session;
		if (!row?.parentVariablesReference || !session || session.state !== 'stopped') return;
		const generation = this.refreshGeneration;
		try {
			const info = await session.dataBreakpointInfo(row.name, row.parentVariablesReference, this.selectedFrameId);
			if (!this.isCurrentInspection(session, generation)) return;
			if (info.dataId === null) throw new Error(info.description);
			const accessType = info.accessTypes.includes('write') ? 'write' : info.accessTypes[0];
			if (!accessType) throw new Error(localize('debug.noDataAccess', 'The adapter did not provide a supported data access type.'));
			await this.commands.executeCommand(ADD_DATA_BREAKPOINT_ID, { ...info, dataId: info.dataId, sessionId: session.id, accessType });
		} catch (error) {
			if (!this.isCurrentInspection(session, generation)) return;
			this.notifications.error(message(error));
			this.render();
		}
	}

	private render(): void {
		const session = this.debug.session;
		const stopped = session?.state === 'stopped';
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
				item = this.variableItems.set(row.key, new DebugVariableItem(this.element.ownerDocument, index => { void this.breakOnVariable(index); }, index => {
					const row = this.variableRows[index];
					if (row?.memoryReference && this.debug.session) void this.commands.executeCommand('workbench.action.debug.viewMemory', this.debug.session.id, row.memoryReference).catch(error => this.notifications.error(message(error)));
				}));
			}
			item.update(row, index, stopped && session.capabilities.supportsSetVariable, stopped && session.capabilities.supportsDataBreakpoints, this.variableEdit?.row.key === row.key ? this.variableEdit.form : undefined, stopped && session.capabilities.supportsReadMemoryRequest === true);
			return item.domNode;
		}));
		if (variableInputWasFocused) this.variableEdit?.input.focus();
	}
	private scopeRow(scope: IDebugScope, expanded: boolean): DebugVariableRow { return Object.freeze({ key: ++this.variableKey, name: scope.name, path: Object.freeze([scope.name]), variablesReference: scope.variablesReference, depth: 0, expanded }); }
	private variableRow(variable: IDebugVariable, depth: number, parentVariablesReference: number, parentPath: readonly string[]): DebugVariableRow {
		return Object.freeze({ key: ++this.variableKey, name: variable.name, path: Object.freeze([...parentPath, variable.name]), value: variable.value, memoryReference: variable.memoryReference, variablesReference: variable.variablesReference, parentVariablesReference, readOnly: variable.presentationHint?.attributes?.includes('readOnly') || variable.presentationHint?.lazy === true, depth, expanded: false, ...(variable.type ? { type: variable.type } : {}) });
	}
}

class DebugVariableItem extends Disposable {
	public readonly domNode: HTMLLIElement;
	private readonly action: HTMLButtonElement;
	private readonly hover: IManagedHover;
	private readonly dataBreakpoint: Button;
	private readonly memory: Button;
	private variableIndex = 0;

	constructor(document: Document, breakOnData: (index: number) => void, viewMemory: (index: number) => void) {
		super();
		this.domNode = h(document, 'li');
		this.action = h(document, 'button');
		this.action.type = 'button';
		this.action.className = 'ash-debug-variable';
		this.hover = this._register(getHoverDelegate().setupHover({ target: this.action, content: '' }));
		this.dataBreakpoint = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: localize('debug.breakOnData', 'Break on data access'),
			icon: Lxicon.add,
			iconOnly: true,
			size: 'small',
			title: localize('debug.breakOnData', 'Break on data access'),
			onClick: () => breakOnData(this.variableIndex),
		}));
		this.memory = this._register(new Button(this.domNode, {
			...defaultButtonStyles, label: localize('debug.viewMemoryShort', 'View memory'), title: localize('debug.viewMemoryShort', 'View memory'), icon: Lxicon.inspect, iconOnly: true, size: 'small', onClick: () => viewMemory(this.variableIndex),
		}));
		this.dataBreakpoint.domNode.classList.add('ash-debug-variable-data');
	}

	public update(row: DebugVariableRow, index: number, supportsSetVariable: boolean, supportsDataBreakpoints: boolean, editForm: HTMLFormElement | undefined, supportsMemory: boolean): void {
		this.variableIndex = index;
		const indicator = row.variablesReference > 0 ? row.expanded ? '▾ ' : '▸ ' : '  ';
		const label = `${indicator}${row.name}${row.value === undefined ? '' : ` = ${row.value}`}${row.type ? ` : ${row.type}` : ''}`;
		this.action.textContent = label;
		this.hover.update(label);
		this.action.dataset.variableIndex = String(index);
		this.action.dataset.variableKey = String(row.key);
		if (row.variablesReference > 0) {
			this.action.setAttribute('aria-expanded', String(row.expanded));
		} else {
			this.action.removeAttribute('aria-expanded');
		}
		if (supportsSetVariable && row.value !== undefined && !row.readOnly) {
			this.action.setAttribute('aria-keyshortcuts', 'F2');
			this.action.setAttribute('aria-description', localize('debug.variableEditHint', 'Press F2 or double-click to change the value.'));
		} else {
			this.action.removeAttribute('aria-keyshortcuts');
			this.action.removeAttribute('aria-description');
		}
		this.action.style.paddingInlineStart = `${6 + row.depth * 14}px`;
		this.action.disabled = row.variablesReference <= 0 && row.value === undefined;
		const canWatch = supportsDataBreakpoints && Boolean(row.parentVariablesReference) && !editForm;
		this.dataBreakpoint.label = localize('debug.breakOnVariable', 'Break on data access for {0}', row.name);
		this.dataBreakpoint.enabled = canWatch;
		this.dataBreakpoint.domNode.hidden = !canWatch;
		this.dataBreakpoint.domNode.classList.toggle('empty', !canWatch);
		this.memory.domNode.hidden = !supportsMemory || !row.memoryReference || !!editForm;
		this.memory.enabled = !this.memory.domNode.hidden;
		this.domNode.replaceChildren(editForm ?? this.action, this.dataBreakpoint.domNode, ...(!this.memory.domNode.hidden ? [this.memory.domNode] : []));
	}
}
function indexFromEvent(event: Event, selector: string, dataName: string, document: Document): number | undefined { const target = event.target instanceof document.defaultView!.Element ? event.target.closest<HTMLElement>(selector) : null; const raw = target?.dataset[dataName]; if (raw === undefined) return undefined; const index = Number(raw); return Number.isSafeInteger(index) && index >= 0 ? index : undefined; }
function descendantEnd(rows: readonly DebugVariableRow[], index: number, depth: number): number { let end = index + 1; while (end < rows.length && rows[end]!.depth > depth) end += 1; return end; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
