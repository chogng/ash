import { scheduleAtNextAnimationFrame, Dimension, type IDimension } from '../../../../base/browser/dom.js';
import type { IView } from '../../../../base/browser/ui/grid/grid.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { Emitter } from '../../../../base/common/event.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import type { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { GroupDirection } from '../../../../workbench/services/editor/common/editorGroupsService.js';

export interface ISessionGridEntry {
	readonly id: string;
	readonly view: IView;
	readonly label?: string;
	readonly activate?: () => void;
	readonly close?: () => void;
	readonly setTabId?: (id: string) => void;
	readonly focus?: () => void;
}

/** Binds Sessions-owned views and saved widths to the shared editor host; EditorPart owns all group geometry. */
export class SessionGridLayout extends Disposable {
	private readonly editor: EditorPart;
	private readonly inputs = this._register(new DisposableMap<IView, SessionGridInput>());
	private readonly restoreFrame = this._register(new MutableDisposable<IDisposable>());
	private entries: readonly ISessionGridEntry[] = [];
	private widths: ReadonlyMap<string, number> | undefined;
	private restorePending = false;
	private changing = false;
	private pending = Promise.resolve();
	private dimension: IDimension | undefined;
	private visible = true;
	private readonly storageKey = 'sessions.gridState';

	public get element(): HTMLElement { return this.editor.domNode; }

	constructor(container: HTMLElement, initialView: IView, @IStorageService private readonly storage: IStorageService, @IInstantiationService services: IInstantiationService) {
		super();
		const raw = storage.get(this.storageKey, StorageScope.WORKSPACE);
		if (raw !== undefined) {
			this.widths = parseStoredWidths(JSON.parse(raw));
		} else {
			const widths = new Map<string, number>();
			for (const key of ['sessions.gridState.code', 'sessions.gridState.chat']) {
				const legacy = storage.get(key, StorageScope.WORKSPACE);
				if (legacy !== undefined) {
					for (const [id, width] of parseStoredWidths(JSON.parse(legacy))) widths.set(id, width);
				}
			}
			if (widths.size) this.widths = widths;
		}
		this.restorePending = this.widths !== undefined;
		const registry = new EditorPaneRegistry();
		this._register(registry.registerEditorPane({
			id: 'ash.sessions.conversation', name: 'Session',
			canOpen: input => input instanceof SessionGridInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
			create: options => services.createInstance(SessionGridPane, options.input as SessionGridInput),
		}));
		// Ash deliberately hosts one Session per group, replacing it in place. VS Code's
		// editor groups normally retain multiple tabs and its Agents window uses a separate grid.
		this.editor = this._register(services.createInstance(EditorPart, container, { registry, editorLimit: 1 }));
		this.element.classList.add('ash-sessions-chat-grid');
		this._register(this.editor.onDidLayout(() => this.captureWidths()));
		this._register(this.editor.onDidChangeEditors(event => {
			if (this.changing) return;
			if (event.kind === 'activeGroupChanged') {
				const input = this.editor.activeInput;
				if (input instanceof SessionGridInput) input.entry.activate?.();
			} else if (event.kind === 'groupChanged' && event.event.kind === 'editorClosed') {
				const closed = event.event;
				if (closed.reason === 'close' || closed.reason === 'replace') {
					const input = closed.editor.input;
					if (input instanceof SessionGridInput && this.inputs.get(input.entry.view) === input) input.entry.close?.();
				}
			}
		}));
		this._register(storage.onWillSaveState(() => this.saveState()));
		this.reconcile([{ id: 'empty', view: initialView }], 'empty');
	}

	public whenReady(): Promise<void> { return this.pending; }

	public reconcile(entries: readonly ISessionGridEntry[], active: string): void {
		if (!entries.length) throw new Error('A Sessions grid must have at least one view');
		const previous = this.entries;
		const oldGroups = new Map<IView, IEditorGroupView>();
		for (const group of this.editor.groups) {
			const input = group.activeInput;
			if (input instanceof SessionGridInput) oldGroups.set(input.entry.view, group);
		}
		const retained = new Set(entries.map(entry => oldGroups.get(entry.view)).filter(group => group !== undefined));
		const available = this.editor.groups.filter(group => !retained.has(group));
		const openings: Promise<unknown>[] = [];
		const groups: IEditorGroupView[] = [];
		this.changing = true;
		try {
			for (const view of [...this.inputs.keys()]) {
				if (!entries.some(entry => entry.view === view)) this.inputs.deleteAndDispose(view);
			}
			for (const entry of entries) {
				let input = this.inputs.get(entry.view);
				if (!input) {
					input = new SessionGridInput(entry);
					this.inputs.set(entry.view, input);
				} else {
					input.update(entry);
				}
				const group = oldGroups.get(entry.view) ?? available.shift() ?? this.editor.addGroup(groups.at(-1)!.id, Direction.Right);
				groups.push(group);
				group.setTitleVisible(entries.length > 1 && entry.id !== 'empty');
				if (group.activeInput !== input) {
					openings.push(group.openEditor(input, { pinned: true, preserveFocus: true }).then(() => {
						const tabId = group.domNode.querySelector<HTMLElement>('[role="tab"]')?.id;
						if (tabId) input.entry.setTabId?.(tabId);
					}));
				}
			}
			for (const group of available) this.editor.removeGroup(group);
			// Model reordering is explicit; ordinary selection updates preserve the editor's 2D arrangement.
			const reordered = previous.length === entries.length && previous.every(entry => entries.some(next => next.view === entry.view)) && previous.some((entry, index) => entry.view !== entries[index]!.view);
			if (reordered) {
				for (let index = 1; index < groups.length; index++) this.editor.moveGroup(groups[index]!, groups[index - 1]!, GroupDirection.RIGHT);
			}
			this.entries = entries;
			const activeIndex = entries.findIndex(entry => entry.id === active);
			this.editor.activateGroup(groups[Math.max(0, activeIndex)]!.id);
		} finally {
			this.changing = false;
		}
		this.pending = Promise.all(openings).then(() => {
			if (this.isDisposed) return;
			if (this.dimension) this.editor.layout(this.dimension);
			this.scheduleRestoreWidths();
			this.saveState();
		});
		void this.pending.catch(error => { if (!isCancellationError(error)) console.error('Failed to display Session', error); });
		this.scheduleRestoreWidths();
	}

	public layout(width: number, height: number): void {
		if (this.widths && this.dimension?.width !== width) this.restorePending = true;
		this.dimension = new Dimension(width, height);
		this.editor.layout(this.dimension);
		this.scheduleRestoreWidths();
		this.saveState();
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.editor.setEditorContentVisible(visible);
		if (!visible) this.restoreFrame.clear();
		else this.scheduleRestoreWidths();
	}

	private sizes(): readonly { readonly id: string; readonly group: IEditorGroupView; readonly width: number; }[] {
		return this.editor.groups.flatMap(group => {
			const input = group.activeInput;
			return input instanceof SessionGridInput && input.entry.id !== 'empty' && this.inputs.get(input.entry.view) === input
				? [{ id: input.entry.id, group, width: this.editor.getSize(group).width }] : [];
		});
	}

	private captureWidths(): void {
		if (this.changing || !this.dimension || this.dimension.width <= 0 || this.restorePending) return;
		const sizes = this.sizes();
		if (!sizes.length) return;
		this.widths = new Map(sizes.map(entry => [entry.id, entry.width]));
		this.saveState();
	}

	private saveState(): void {
		if (this.changing || this.restorePending || !this.dimension || this.dimension.width <= 0) return;
		const sizes = this.sizes();
		if (!sizes.length) return;
		this.widths ??= new Map(sizes.map(entry => [entry.id, entry.width]));
		const widths = sizes.map(entry => ({ id: entry.id, width: this.widths!.get(entry.id) ?? entry.width }));
		this.storage.store(this.storageKey, JSON.stringify({ version: 1, widths }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.storage.remove('sessions.gridState.chat', StorageScope.WORKSPACE);
		this.storage.remove('sessions.gridState.code', StorageScope.WORKSPACE);
	}

	private scheduleRestoreWidths(): void {
		if (!this.visible || !this.restorePending || !this.widths || !this.dimension || this.dimension.width <= 0 || this.dimension.height <= 0 || this.restoreFrame.value) return;
		this.restoreFrame.value = scheduleAtNextAnimationFrame(this.element.ownerDocument.defaultView!, () => {
			this.restoreFrame.clear();
			const sizes = this.sizes();
			if (!sizes.length) return;
			if (sizes.some(entry => this.widths!.has(entry.id))) {
				const widths = sizes.map(entry => this.widths!.get(entry.id) ?? entry.width);
				const total = widths.reduce((sum, width) => sum + width, 0);
				for (let index = 0; index < sizes.length; index++) {
					const group = sizes[index]!.group;
					this.editor.setSize(group, { width: widths[index]! / total * this.dimension!.width, height: this.editor.getSize(group).height });
				}
			} else {
				this.widths = undefined;
			}
			this.restorePending = false;
			this.captureWidths();
		});
	}
}

let sessionGridInputId = 0;

/** The binding can change when an untitled conversation acquires a durable Session id. */
class SessionGridInput extends EditorInput {
	public readonly typeId = 'ash.sessions.conversation';
	public override readonly editorId = this.typeId;
	public readonly resource = URI.from({ scheme: 'ash-session-view', path: `/${++sessionGridInputId}` });
	private readonly labelChanged = this._register(new Emitter<void>());
	public readonly onDidChangeLabel = this.labelChanged.event;

	constructor(public entry: ISessionGridEntry) { super(); }
	public getName(): string { return this.entry.label ?? this.entry.id; }
	public update(entry: ISessionGridEntry): void {
		const label = this.getName();
		this.entry = entry;
		if (label !== this.getName()) this.labelChanged.fire();
	}
}

/** Borrows the live Session view: moving an editor must not dispose the conversation or its draft. */
class SessionGridPane extends EditorPane {
	public readonly id = 'ash.sessions.conversation';

	constructor(private readonly input: SessionGridInput, @IThemeService theme: IThemeService, @IStorageService storage: IStorageService) {
		super('session-grid-pane', theme, storage);
	}
	public override create(parent: HTMLElement): void {
		super.create(parent);
		parent.append(this.input.entry.view.element);
		this._register(toDisposable(() => {
			if (this.input.entry.view.element.parentElement === parent) this.input.entry.view.element.remove();
		}));
	}
	public async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); }
	public clearInput(): void { }
	public layout(dimension: IDimension): void { this.input.entry.view.layout({ ...dimension, top: 0, left: 0 }); }
	public focus(): void { this.input.entry.activate?.(); this.input.entry.focus?.(); }
}

function parseStoredWidths(value: unknown): ReadonlyMap<string, number> {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.widths) || value.widths.length === 0) {
		throw new TypeError('Invalid stored Sessions grid state');
	}
	const widths = new Map<string, number>();
	for (const entry of value.widths) {
		if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0 || widths.has(entry.id)
			|| typeof entry.width !== 'number' || !Number.isFinite(entry.width) || entry.width <= 0) {
			throw new TypeError('Invalid stored Sessions pane width');
		}
		widths.set(entry.id, entry.width);
	}
	return widths;
}
