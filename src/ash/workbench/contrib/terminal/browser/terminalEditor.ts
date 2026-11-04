import { h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Orientation, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { ITerminalService, ITerminalEditorService, type ITerminalInstance } from './terminal.js';
import { TerminalEditorInput, type TerminalEditorPaneState } from './terminalEditorInput.js';
import './media/terminal.css';
import { ConfirmResult } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/** Hosts the original xterm; disposing a pane releases its DOM lease, not its PTY. */
export class TerminalEditor extends EditorPane {
	readonly id = TerminalEditorInput.ID;
	readonly prefersCompactTitlebar = true;
	private element!: HTMLElement;
	private input: TerminalEditorInput | undefined;
	private readonly inputLifetime = this._register(new MutableDisposable());
	private readonly layoutLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly hosts = new Map<ITerminalInstance, HTMLElement>();
	private splitView: SplitView | undefined;
	private dimension: IDimension = { width: 0, height: 0 };
	private visible = false;

	constructor(
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
		this.inputLifetime.value = autorun(reader => this.renderPanes(input.panes.read(reader)));
		await Promise.all([...this.hosts.keys()].map(instance => instance.xtermReadyPromise));
		signal.throwIfAborted();
	}

	private renderPanes(states: readonly TerminalEditorPaneState[]): void {
		const restoreFocus = this.element.contains(this.element.ownerDocument.activeElement);
		this.releaseHosts();
		const panes = states.flatMap(state => {
			const instance = this.editorTerminals.getInstanceFromResource(state.resource);
			return instance ? [{ ...state, instance }] : [];
		});
		if (!panes.length) {
			this.element.textContent = localize('terminal.editor.unavailable', 'This terminal is no longer available. Create a new terminal to start another shell.');
			this.element.setAttribute('role', 'status');
			return;
		}
		this.element.removeAttribute('role');
		const lifetime = new DisposableStore();
		this.layoutLifetime.value = lifetime;
		if (panes.length > 1) {
			this.splitView = lifetime.add(new SplitView(this.element, {
				orientation: Orientation.VERTICAL,
				preserveSplitWeights: true,
				styles: { separatorBorder: 'var(--ash-contrastBorder, var(--ash-editorGroup-border))' },
			}));
			this.splitView.element.classList.add('ash-terminal-group');
		}
		for (const [index, { instance, resource, size }] of panes.entries()) {
			const host = h(this.element.ownerDocument, 'div', { className: 'ash-terminal-group-pane' });
			this.hosts.set(instance, host);
			instance.target = TerminalLocation.Editor;
			if (this.splitView) {
				this.splitView.addView({
					element: host, minimumSize: 80, maximumSize: Number.POSITIVE_INFINITY,
					layout: () => { if (this.visible && instance.xterm?.element.parentElement === host) instance.xterm.fit(); },
				}, size);
			} else {
				this.element.append(host);
			}
			instance.attachToElement(host);
			let closeButton: Button | undefined;
			if (this.splitView) {
				host.classList.add('ash-terminal-editor-split-pane');
				const label = localize('terminal.editor.closePaneAtPosition', 'Close Terminal Pane {0}', index + 1);
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
			}));
		}
		const split = this.splitView;
		if (split) {
			for (let index = 0; index < panes.length - 1; index++) {
				split.getSash(index)?.element.setAttribute('aria-label', localize('terminal.group.resize', 'Resize terminal panes'));
			}
			lifetime.add(split.onDidSashChange(() => {
				this.input?.resizePanes(new Map(panes.map((pane, index) => [pane.resource, split.getViewLayoutSize(index)])));
			}));
		}
		this.layout(this.dimension);
		this.setVisible(this.visible);
		if (restoreFocus) this.focus();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible = visible;
		for (const [instance, host] of this.hosts) {
			if (visible && !instance.xterm?.element.isConnected) instance.attachToElement(host);
			if (instance.xterm?.element.parentElement === host) instance.xterm.setVisible(visible);
		}
	}

	override clearInput(): void {
		this.inputLifetime.clear();
		this.input = undefined;
		this.releaseHosts();
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
		this.splitView = undefined;
		this.layoutLifetime.clear();
		this.element?.replaceChildren();
	}

	override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.element.style.width = `${dimension.width}px`;
		this.element.style.height = `${dimension.height}px`;
		if (dimension.height > 0 && dimension.width > 0) this.splitView?.layout(dimension.height, dimension.width);
		if (!this.splitView) {
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
