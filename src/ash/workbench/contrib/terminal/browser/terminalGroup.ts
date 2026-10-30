import { addDisposableListener } from '../../../../base/browser/dom.js';
import { IWorkbenchLayoutService, isHorizontal } from '../../../services/layout/browser/layoutService.js';
import { SplitView, Orientation } from '../../../../base/browser/ui/splitview/splitview.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ITerminalService, type ITerminalGroup, type ITerminalInstance } from './terminal.js';
import type { ITerminalTabLayoutInfoById } from '../../../../platform/terminal/common/terminal.js';

/** Owns one panel group's panes. Moving a pane retains its instance, PTY and xterm buffer. */
export class TerminalGroup extends Disposable implements ITerminalGroup {
	private readonly instances: ITerminalInstance[] = [];
	private readonly changed = this._register(new Emitter<void>());
	readonly onInstancesChanged = this.changed.event;
	private readonly layoutLifetime = this._register(new MutableDisposable<DisposableStore>());
	private splitView: SplitView | undefined;
	private readonly panes = new Map<ITerminalInstance, HTMLElement>();
	private container: HTMLElement | undefined;
	private visible = false;
	private width = 0;
	private height = 0;
	private relativeSizes: number[] = [1];
	private orientation: Orientation;

	constructor(
		instance: ITerminalInstance,
		@ITerminalService private readonly terminals: ITerminalService,
		@IWorkbenchLayoutService private readonly workbenchLayout: IWorkbenchLayoutService,
	) {
		super();
		this.instances.push(instance);
		this.orientation = isHorizontal(workbenchLayout.getPanelPosition()) ? Orientation.HORIZONTAL : Orientation.VERTICAL;
		this._register(workbenchLayout.onDidChangePanelPosition(() => this.layout(this.width, this.height)));
	}

	get terminalInstances(): readonly ITerminalInstance[] { return this.instances; }
	get activeInstance(): ITerminalInstance | undefined {
		const active = this.terminals.activeInstance;
		return active && this.instances.includes(active) ? active : this.instances[0];
	}
	get title(): string { return this.instances.map(instance => instance.title).join(', '); }

	addInstance(instance: ITerminalInstance): void {
		if (this.isDisposed || this.instances.includes(instance)) return;
		this.relativeSizes.push(this.relativeSizes.at(-1) ?? 1);
		this.instances.push(instance);
		this.rebuildLayout();
		this.changed.fire();
	}

	removeInstance(instance: ITerminalInstance): void {
		const index = this.instances.indexOf(instance);
		if (index < 0) return;
		this.relativeSizes.splice(index, 1);
		instance.detachFromElement();
		this.instances.splice(index, 1);
		this.rebuildLayout();
		this.changed.fire();
	}

	moveInstance(instances: ITerminalInstance | readonly ITerminalInstance[], index: number, position: 'before' | 'after'): void {
		const target = this.instances[index];
		const moving = new Set(Array.isArray(instances) ? instances : [instances]);
		if (!target || moving.has(target)) return;
		const sizes = new Map(this.instances.map((instance, i) => [instance, this.relativeSizes[i] ?? 1]));
		const members = this.instances.filter(instance => moving.has(instance));
		if (!members.length) return;
		const remaining = this.instances.filter(instance => !moving.has(instance));
		remaining.splice(remaining.indexOf(target) + (position === 'after' ? 1 : 0), 0, ...members);
		this.instances.splice(0, this.instances.length, ...remaining);
		this.relativeSizes = remaining.map(instance => sizes.get(instance)!);
		this.rebuildLayout();
		this.changed.fire();
	}

	attachToElement(element: HTMLElement): void {
		if (this.isDisposed) return;
		if (!this.splitView || this.container !== element) {
			this.container = element;
			this.rebuildLayout();
		}
		// A View may have detached screens while this window's group survived.
		for (const [instance, pane] of this.panes) {
			if (instance.xterm?.element.parentElement !== pane) instance.attachToElement(pane);
		}
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (this.splitView) this.splitView.element.hidden = !visible;
		for (const instance of this.instances) instance.xterm?.setVisible(visible);
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		// Hidden Panels have no geometry for a new axis; retain panes until the next visible layout.
		if (width <= 0 || height <= 0) return;
		const orientation = isHorizontal(this.workbenchLayout.getPanelPosition()) ? Orientation.HORIZONTAL : Orientation.VERTICAL;
		if (this.orientation !== orientation) {
			this.orientation = orientation;
			this.rebuildLayout();
			return;
		}
		this.splitView?.layout(this.primarySize, this.orientation === Orientation.HORIZONTAL ? height : width);
		this.applyPaneSizes();
	}

	private get primarySize(): number { return this.orientation === Orientation.HORIZONTAL ? this.width : this.height; }

	resizePanes(relativeSizes: number[]): void {
		this.relativeSizes = [...relativeSizes];
		this.applyPaneSizes();
	}

	private applyPaneSizes(): void {
		if (!this.splitView || this.primarySize <= 0) return;
		const total = this.relativeSizes.reduce((sum, size) => sum + size, 0);
		for (let index = 0; index < this.relativeSizes.length - 1; index++) {
			this.splitView.resizeView(index, this.primarySize * this.relativeSizes[index]! / total);
		}
	}

	getLayoutInfo(isActive: boolean): ITerminalTabLayoutInfoById {
		const sizes = this.instances.map((_, index) => this.relativeSizes[index] ?? 1);
		const total = sizes.reduce((sum, size) => sum + size, 0);
		return { isActive, activePersistentProcessId: this.activeInstance?.instanceId, terminals: this.instances.map((instance, index) => ({ terminal: instance.instanceId, relativeSize: total > 0 ? sizes[index]! / total : 1 / this.instances.length })) };
	}

	focusPreviousPane(): void { this.focusPane(-1); }
	focusNextPane(): void { this.focusPane(1); }

	private focusPane(delta: number): void {
		if (!this.instances.length) return;
		const index = this.instances.indexOf(this.activeInstance!);
		const instance = this.instances[(index + delta + this.instances.length) % this.instances.length]!;
		this.terminals.setActiveInstance(instance);
		instance.xterm?.focus();
	}

	private rebuildLayout(): void {
		if (!this.container) return;
		const activeElement = this.container.ownerDocument.activeElement;
		const focusedInstance = this.instances.find(instance => instance.xterm?.element.contains(activeElement));
		const focusedSash = this.instances.findIndex((_, index) => this.splitView?.getSash(index)?.element === activeElement);
		// Detach before disposing the old layout so xterm's DOM and buffer survive.
		for (const instance of this.instances) instance.detachFromElement();
		this.layoutLifetime.clear();
		this.panes.clear();
		const lifetime = new DisposableStore();
		this.layoutLifetime.value = lifetime;
		const split = lifetime.add(new SplitView(this.container, { proportionalLayout: false, orientation: this.orientation, styles: { separatorBorder: 'var(--ash-contrastBorder, var(--ash-editorGroup-border))' }, }));
		this.splitView = split;
		split.element.classList.add('ash-terminal-group');
		for (const instance of this.instances) {
			const pane = this.container.ownerDocument.createElement('div');
			pane.className = 'ash-terminal-group-pane';
			pane.dataset.instanceId = instance.id;
			this.panes.set(instance, pane);
			instance.attachToElement(pane);
			lifetime.add(addDisposableListener(pane, 'focusin', () => this.terminals.setActiveInstance(instance)));
			split.addView({
				element: pane, minimumSize: this.orientation === Orientation.HORIZONTAL ? 120 : 80, maximumSize: Number.POSITIVE_INFINITY,
				layout: () => { if (this.visible) instance.xterm?.fit(); },
			}, { type: 'distribute' });
		}
		for (let index = 0; index < this.instances.length - 1; index++) {
			split.getSash(index)?.element.setAttribute('aria-label', localize('terminal.group.resize', 'Resize terminal panes'));
		}
		// Desired proportions change through pane operations and user sash input.
		// Intermediate Grid sizes may clamp the rendered panes; those temporary
		// sizes must never replace the proportions restored on the final layout.
		lifetime.add(split.onDidSashChange(() => {
			this.relativeSizes = this.instances.map((_, index) => split.getViewSize(index));
		}));
		this.setVisible(this.visible);
		this.layout(this.width, this.height);
		// Reparenting a surviving screen blurs its textarea; retain its input focus.
		focusedInstance?.xterm?.focus();
		if (focusedSash >= 0) split.getSash(focusedSash)?.element.focus();
	}

	protected override disposeCore(): void {
		for (const instance of this.instances) instance.detachFromElement();
		this.panes.clear();
		this.container = undefined;
		this.splitView = undefined;
		super.disposeCore();
	}
}
