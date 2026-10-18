import { addDisposableListener } from '../../../../base/browser/dom.js';
import { SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
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
	private initialSizes: number[] | undefined;

	constructor(instance: ITerminalInstance, @ITerminalService private readonly terminals: ITerminalService) {
		super();
		this.instances.push(instance);
	}

	get terminalInstances(): readonly ITerminalInstance[] { return this.instances; }
	get activeInstance(): ITerminalInstance | undefined {
		const active = this.terminals.activeInstance;
		return active && this.instances.includes(active) ? active : this.instances[0];
	}
	get title(): string { return this.instances.map(instance => instance.title).join(', '); }

	addInstance(instance: ITerminalInstance): void {
		if (this.isDisposed || this.instances.includes(instance)) return;
		this.instances.push(instance);
		this.rebuildLayout();
		this.changed.fire();
	}

	removeInstance(instance: ITerminalInstance): void {
		const index = this.instances.indexOf(instance);
		if (index < 0) return;
		instance.detachFromElement();
		this.instances.splice(index, 1);
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
		this.splitView?.layout(width, height);
		if (width > 0 && this.initialSizes && this.splitView) {
			const sizes = this.initialSizes;
			this.initialSizes = undefined;
			this.resizePanes(sizes);
		}
	}

	resizePanes(relativeSizes: number[]): void {
		if (!this.splitView || this.width <= 0) { this.initialSizes = [...relativeSizes]; return; }
		const total = relativeSizes.reduce((sum, size) => sum + size, 0);
		for (let index = 0; index < relativeSizes.length - 1; index++) this.splitView.resizeView(index, this.width * relativeSizes[index]! / total);
	}

	getLayoutInfo(isActive: boolean): ITerminalTabLayoutInfoById {
		const sizes = this.instances.map((_, index) => this.splitView?.getViewSize(index) ?? this.initialSizes?.[index] ?? 1);
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
		// Detach before disposing the old layout so xterm's DOM and buffer survive.
		for (const instance of this.instances) instance.detachFromElement();
		this.layoutLifetime.clear();
		this.panes.clear();
		const lifetime = new DisposableStore();
		this.layoutLifetime.value = lifetime;
		const split = lifetime.add(new SplitView(this.container, 'horizontal', {
			styles: { separatorBorder: 'var(--ash-contrastBorder, var(--ash-editorGroup-border))' },
		}));
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
				element: pane, minimumSize: 120, maximumSize: Number.POSITIVE_INFINITY,
				layout: () => { if (this.visible) instance.xterm?.fit(); },
			}, { type: 'distribute' });
		}
		for (let index = 0; index < this.instances.length - 1; index++) {
			split.getSash(index)?.element.setAttribute('aria-label', localize('terminal.group.resize', 'Resize terminal panes'));
		}
		this.setVisible(this.visible);
		this.layout(this.width, this.height);
		// Reparenting a surviving screen blurs its textarea; retain its input focus.
		focusedInstance?.xterm?.focus();
	}

	protected override disposeCore(): void {
		for (const instance of this.instances) instance.detachFromElement();
		this.panes.clear();
		this.container = undefined;
		this.splitView = undefined;
		super.disposeCore();
	}
}
