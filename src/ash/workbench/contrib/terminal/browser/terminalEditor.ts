import { h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SerializableGrid, type GridDescriptor, type ISerializableView, type SerializedGridDescriptor } from '../../../../base/browser/ui/grid/grid.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { ITerminalService, ITerminalEditorService, type ITerminalInstance } from './terminal.js';
import { filterTerminalEditorLayout, TerminalEditorInput, type TerminalEditorPaneLayout } from './terminalEditorInput.js';
import { canSplitTerminalInstance } from './terminalEditorService.js';
import { TerminalEditorCanSplitContext } from '../common/terminalContextKey.js';
import './media/terminal.css';
import { ConfirmResult } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

function layoutFromGrid(node: SerializedGridDescriptor, size = 1): TerminalEditorPaneLayout {
	if (node.type === 'leaf') return { resource: node.data as URI, size };
	const total = node.children.reduce((sum, child) => sum + child.size, 0);
	return { orientation: node.orientation, size, children: node.children.map(child => layoutFromGrid(child, total > 0 ? child.size / total : 1 / node.children.length)) };
}

/** Hosts the original xterm; disposing a pane releases its DOM lease, not its PTY. */
export class TerminalEditor extends EditorPane {
	readonly id = TerminalEditorInput.ID;
	readonly prefersCompactTitlebar = true;
	private element!: HTMLElement;
	private input: TerminalEditorInput | undefined;
	private readonly inputLifetime = this._register(new MutableDisposable());
	private readonly layoutLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly hosts = new Map<ITerminalInstance, HTMLElement>();
	private grid: SerializableGrid<ISerializableView> | undefined;
	private renderedLayout: TerminalEditorPaneLayout | undefined;
	private splitAvailable: IContextKey<boolean> | undefined;
	private dimension: IDimension = { width: 0, height: 0 };
	private visible = false;

	constructor(
		private readonly groupContext: IContextKeyService | undefined,
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalEditorService private readonly editorTerminals: ITerminalEditorService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
		@IEditorService private readonly editors: IEditorService,
	) { super(TerminalEditorInput.ID, theme, storage); }

	override create(parent: HTMLElement): void {
		this.element = h(parent.ownerDocument, 'div');
		this.element.className = 'ash-terminal-editor';
		parent.append(this.element);
		super.create(this.element);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!(input instanceof TerminalEditorInput)) throw new TypeError('Invalid terminal editor input');
		this.clearInput();
		signal.throwIfAborted();
		await this.terminals.whenConnected;
		signal.throwIfAborted();
		this.input = input;
		const liveInstances = () => input.panes.get().flatMap(({ resource }) => {
			const instance = this.editorTerminals.getInstanceFromResource(resource);
			return instance ? [instance] : [];
		});
		input.closeHandler = {
			showConfirm: () => liveInstances().length > 0,
			confirm: async closingEditors => {
				for (const instance of liveInstances()) {
					const resource = instance.resource!;
					const retained = this.editorGroups.groups.some(group => group.inputs.some(other =>
						other instanceof TerminalEditorInput && other.contains(resource)
						&& !closingEditors.some(candidate => candidate.groupId === group.id && candidate.editor === other),
					));
					if (!retained && !await this.terminals.confirmTerminalClose(instance)) return ConfirmResult.CANCEL;
				}
				return ConfirmResult.DONT_SAVE;
			},
		};
		this.inputLifetime.value = autorun(reader => {
			const layout = input.layout.read(reader);
			if (layout !== this.renderedLayout) this.renderPanes(layout);
		});
		await Promise.all([...this.hosts.keys()].map(instance => instance.xtermReadyPromise));
		signal.throwIfAborted();
	}

	private renderPanes(layout: TerminalEditorPaneLayout | undefined): void {
		const restoreFocus = this.element.contains(this.element.ownerDocument.activeElement);
		this.releaseHosts();
		this.renderedLayout = layout;
		const live = filterTerminalEditorLayout(layout, resource => this.editorTerminals.getInstanceFromResource(resource) !== undefined);
		if (!live) {
			this.element.textContent = localize('terminal.editor.unavailable', 'This terminal is no longer available. Create a new terminal to start another shell.');
			this.element.setAttribute('role', 'status');
			this.updateSplitAvailability();
			return;
		}
		this.element.removeAttribute('role');
		const lifetime = new DisposableStore();
		this.layoutLifetime.value = lifetime;
		const isSplit = 'children' in live;
		const createView = (resource: URI): ISerializableView => {
			const instance = this.editorTerminals.getInstanceFromResource(resource)!;
			const host = h(this.element.ownerDocument, 'div', { className: 'ash-terminal-group-pane' });
			this.hosts.set(instance, host);
			instance.target = TerminalLocation.Editor;
			instance.attachToElement(host);
			let closeButton: Button | undefined;
			if (isSplit) {
				host.classList.add('ash-terminal-editor-split-pane');
				const label = localize('terminal.editor.closePaneAtPosition', 'Close Terminal Pane {0}', this.hosts.size);
				closeButton = lifetime.add(new Button(host, { label, title: label, icon: Lxicon.close, iconOnly: true, size: 'small' }));
				closeButton.domNode.classList.add('ash-terminal-editor-close-pane');
				let closing = false;
				lifetime.add(closeButton.onDidClick(() => {
					if (closing) return;
					closing = true;
					void this.terminals.safeDisposeTerminal(instance).catch(onUnexpectedError).finally(() => { closing = false; });
				}));
			}
			lifetime.add(addDisposableListener(host, 'focusin', event => {
				if (event.target === closeButton?.domNode) return;
				if (this.input) this.input.activeResource = resource;
				this.terminals.setActiveInstance(instance);
				this.updateSplitAvailability();
			}));
			lifetime.add(instance.onDidChangeState(() => this.updateSplitAvailability()));
			return {
				element: host, minimumWidth: 120, minimumHeight: 80, maximumWidth: Infinity, maximumHeight: Infinity,
				layout: () => { if (this.visible && instance.xterm?.element.parentElement === host) instance.xterm.fit(); },
				toJSON: () => resource,
			};
		};
		if (isSplit) {
			const describe = (node: TerminalEditorPaneLayout): GridDescriptor<ISerializableView> => 'children' in node
				? { type: 'branch', orientation: node.orientation, size: node.size, children: node.children.map(describe) }
				: { type: 'leaf', size: node.size, view: createView(node.resource) };
			const grid = this.grid = lifetime.add(new SerializableGrid(this.element, describe(live), {
				preserveSplitWeights: true,
				styles: { separatorBorder: 'var(--ash-contrastBorder, var(--ash-editorGroup-border))' },
			}));
			grid.element.classList.add('ash-terminal-group');
			for (const sash of grid.element.querySelectorAll('[role="separator"]')) {
				sash.setAttribute('aria-label', localize('terminal.group.resize', 'Resize terminal panes'));
			}
			lifetime.add(Event.any(grid.onDidSashChange, grid.onDidSashReset)(() => {
				// Keep the mounted grid and its focused separator during a geometry-only change.
				const layout = this.renderedLayout = layoutFromGrid(grid.serialize());
				this.input?.setPaneLayout(layout);
			}));
		} else {
			this.element.append(createView(live.resource).element);
		}
		this.layout(this.dimension);
		this.setVisible(this.visible);
		if (restoreFocus) this.focus();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (!visible && this.visible) this.splitAvailable?.reset();
		this.visible = visible;
		this.updateSplitAvailability();
		for (const [instance, host] of this.hosts) {
			if (visible && !instance.xterm?.element.isConnected) instance.attachToElement(host);
			if (instance.xterm?.element.parentElement === host) instance.xterm.setVisible(visible);
		}
	}

	private updateSplitAvailability(): void {
		if (!this.visible || !this.groupContext) return;
		this.splitAvailable ??= TerminalEditorCanSplitContext.bindTo(this.groupContext);
		this.splitAvailable.set(canSplitTerminalInstance(this.getControl()));
	}

	override clearInput(): void {
		this.inputLifetime.clear();
		this.input = undefined;
		this.renderedLayout = undefined;
		this.releaseHosts();
		this.updateSplitAvailability();
	}

	private releaseHosts(): void {
		for (const [instance, host] of this.hosts) {
			const screen = instance.xterm;
			if (screen?.element.parentElement !== host) continue;
			instance.detachFromElement();
			// A move may have opened another pane for this input before the source was released.
			const retained = this.editors.visibleEditorPanes.find((pane): pane is TerminalEditor =>
				pane instanceof TerminalEditor && pane !== this && !pane.isDisposed && pane.visible && pane.hosts.has(instance),
			);
			const destination = retained?.hosts.get(instance);
			if (destination && instance.target === TerminalLocation.Editor && this.terminals.instances.includes(instance)) {
				instance.attachToElement(destination);
				screen.setVisible(true);
				screen.fit();
			}
		}
		this.hosts.clear();
		this.grid = undefined;
		this.layoutLifetime.clear();
		this.element?.replaceChildren();
	}

	override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.element.style.width = `${dimension.width}px`;
		this.element.style.height = `${dimension.height}px`;
		if (dimension.height > 0 && dimension.width > 0) this.grid?.layout(dimension.width, dimension.height);
		if (!this.grid) {
			for (const [instance, host] of this.hosts) {
				if (instance.xterm?.element.parentElement === host) instance.xterm.fit();
			}
		}
	}

	focusAdjacentPane(delta: number): void {
		const panes = [...this.hosts.keys()];
		if (panes.length < 2) return;
		const index = panes.indexOf(this.getControl()!);
		const instance = panes[(index + delta + panes.length) % panes.length]!;
		this.focusInstance(instance);
	}

	override focus(): void {
		const instance = this.getControl();
		if (instance) this.focusInstance(instance);
	}

	private focusInstance(instance: ITerminalInstance): void {
		instance.attachToElement(this.hosts.get(instance)!);
		instance.xterm?.setVisible(this.visible);
		instance.xterm?.fit();
		instance.xterm?.focus();
	}

	override getControl(): ITerminalInstance | undefined {
		const active = this.input?.activeResource;
		return [...this.hosts.keys()].find(instance => instance.resource?.path === active?.path) ?? this.hosts.keys().next().value;
	}
	protected override disposeCore(): void { this.clearInput(); super.disposeCore(); }
}
