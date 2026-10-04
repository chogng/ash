import { Emitter } from "../../../base/common/event.js";
import { DisposableMap } from "../../../base/common/lifecycle.js";
import { WorkbenchPart } from "../part.js";
import { PaneComposite } from "./views/paneComposite.js";

/**
 * Workbench Part that retains and activates one PaneComposite at a time.
 *
 * The shared content area hosts the active Composite. Pane-like subclasses
 * add their standard title and CompositeBar through PaneCompositePart.
 */
export abstract class CompositePart extends WorkbenchPart {
	private readonly composites = this._register(new DisposableMap<string, PaneComposite>());
	private activeComposite: PaneComposite | undefined;
	private readonly compositeOpened = this._register(new Emitter<PaneComposite>());
	private readonly compositeClosed = this._register(new Emitter<PaneComposite>());
	public readonly onDidCompositeOpen = this.compositeOpened.event;
	public readonly onDidCompositeClose = this.compositeClosed.event;

	protected constructor(container: HTMLElement, id: string) {
		super(container, id);
		this.contentDomNode.classList.add("ash-composite-content");
	}

	addComposite(composite: PaneComposite): void {
		if (this.composites.has(composite.id)) {
			throw new Error(`Composite already exists in Part: ${composite.id}`);
		}
		this.composites.set(composite.id, composite);
		composite.setVisible(false);
	}

	getComposite(compositeId: string): PaneComposite | undefined {
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

	showComposite(compositeId: string): void {
		const composite = this.composites.get(compositeId);
		if (!composite) {
			throw new Error(`Composite is not available in Part: ${compositeId}`);
		}
		if (this.activeComposite === composite) {
			if (!composite.isVisible() && !this.domNode.hidden) {
				composite.setVisible(true);
				this.compositeOpened.fire(composite);
			}
			return;
		}
		if (this.activeComposite) {
			const previous = this.activeComposite;
			const visible = previous.isVisible();
			previous.setVisible(false);
			previous.element.remove();
			this.activeComposite = undefined;
			if (visible) { this.compositeClosed.fire(previous); }
		}
		this.activeComposite = composite;
		this.contentDomNode.append(composite.element);
		composite.setVisible(!this.domNode.hidden);
		if (!this.domNode.hidden) { this.compositeOpened.fire(composite); }
	}

	override setVisible(visible: boolean): void {
		const changed = this.domNode.hidden === visible;
		super.setVisible(visible);
		this.activeComposite?.setVisible(visible);
		if (changed && this.activeComposite) {
			if (visible) { this.compositeOpened.fire(this.activeComposite); }
			else { this.compositeClosed.fire(this.activeComposite); }
		}
	}

	public getActiveComposite(): PaneComposite | undefined { return this.activeComposite; }

	get activeCompositeId(): string | undefined {
		return this.activeComposite?.id;
	}
}
