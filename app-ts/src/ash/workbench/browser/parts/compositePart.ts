import { Emitter } from "../../../base/common/event.js";
import { DisposableMap } from "../../../base/common/lifecycle.js";
import { WorkbenchPart } from "../part.js";
import type { IComposite } from '../../common/composite.js';
import type { Composite } from '../composite.js';

/**
 * Workbench Part that retains and activates one PaneComposite at a time.
 *
 * The shared content area hosts the active Composite. Pane-like subclasses
 * add their standard title and CompositeBar through PaneCompositePart.
 */
export abstract class CompositePart<T extends Composite> extends WorkbenchPart {
	private readonly composites = this._register(new DisposableMap<string, T>());
	private activeComposite: T | undefined;
	private pendingFocus = false;
	private readonly compositeOpened = this._register(new Emitter<{ composite: IComposite; focus: boolean; }>());
	private readonly compositeClosed = this._register(new Emitter<IComposite>());
	public readonly onDidCompositeOpen = this.compositeOpened.event;
	public readonly onDidCompositeClose = this.compositeClosed.event;

	protected constructor(container: HTMLElement, id: string) {
		super(container, id);
		this.contentDomNode.classList.add("ash-composite-content");
	}

	addComposite(composite: T): void {
		const id = composite.getId();
		if (this.composites.has(id)) {
			throw new Error(`Composite already exists in Part: ${id}`);
		}
		this.composites.set(id, composite);
		composite.setVisible(false);
	}

	getComposite(compositeId: string): T | undefined {
		return this.composites.get(compositeId);
	}

	protected removeComposite(compositeId: string): boolean {
		const composite = this.composites.get(compositeId);
		if (!composite) { return false; }
		if (this.activeComposite === composite) {
			const visible = composite.isVisible();
			this.activeComposite = undefined;
			composite.setVisible(false);
			if (visible) { this.compositeClosed.fire(composite); }
		}
		return this.composites.deleteAndDispose(compositeId);
	}

	showComposite(compositeId: string, focus = false): void {
		const composite = this.composites.get(compositeId);
		if (!composite) {
			throw new Error(`Composite is not available in Part: ${compositeId}`);
		}
		this.pendingFocus = focus;
		if (this.activeComposite === composite) {
			if (!composite.isVisible() && !this.domNode.hidden) {
				composite.setVisible(true);
				this.compositeOpened.fire({ composite, focus });
			}
			if (focus && composite.isVisible()) {
				this.pendingFocus = false;
				composite.focus();
			}
			return;
		}
		if (this.activeComposite) {
			const previous = this.activeComposite;
			const visible = previous.isVisible();
			previous.setVisible(false);
			previous.getContainer()!.remove();
			this.activeComposite = undefined;
			if (visible) { this.compositeClosed.fire(previous); }
		}
		this.activeComposite = composite;
		this.contentDomNode.append(composite.getContainer()!);
		composite.setVisible(!this.domNode.hidden);
		if (!this.domNode.hidden) {
			this.compositeOpened.fire({ composite, focus });
			this.pendingFocus = false;
			if (focus) { composite.focus(); }
		}
	}

	override setVisible(visible: boolean): void {
		const changed = this.domNode.hidden === visible;
		super.setVisible(visible);
		this.activeComposite?.setVisible(visible);
		if (changed && this.activeComposite) {
			if (visible) { this.compositeOpened.fire({ composite: this.activeComposite, focus: this.pendingFocus }); }
			else { this.compositeClosed.fire(this.activeComposite); }
		}
		if (visible && this.pendingFocus) { this.activeComposite?.focus(); }
		this.pendingFocus = false;
	}

	public getActiveComposite(): IComposite | undefined { return this.activeComposite; }

	get activeCompositeId(): string | undefined {
		return this.activeComposite?.getId();
	}
}
