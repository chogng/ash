import { toDisposable } from "../../../base/common/lifecycle.js";
import { WorkbenchPart } from "../part.js";
import { PaneComposite } from "./views/paneComposite.js";

/**
 * Workbench Part that retains and activates one PaneComposite at a time.
 *
 * The shared content area hosts the active Composite. Pane-like subclasses
 * add their standard title and CompositeBar through PaneCompositePart.
 */
export abstract class CompositePart extends WorkbenchPart {
	private readonly composites = new Map<string, PaneComposite>();
	private activeComposite: PaneComposite | undefined;

	protected constructor(container: HTMLElement, id: string) {
		super(container, id);
		this.contentDomNode.classList.add("ash-composite-content");
		this._register(toDisposable(() => this.composites.clear()));
	}

	addComposite(composite: PaneComposite): void {
		if (this.composites.has(composite.id)) {
			throw new Error(`Composite already exists in Part: ${composite.id}`);
		}
		this.composites.set(composite.id, this._register(composite));
		composite.setVisible(false);
	}

	getComposite(compositeId: string): PaneComposite | undefined {
		return this.composites.get(compositeId);
	}

	showComposite(compositeId: string): void {
		const composite = this.composites.get(compositeId);
		if (!composite) {
			throw new Error(`Composite is not available in Part: ${compositeId}`);
		}
		if (this.activeComposite === composite) return;
		if (this.activeComposite) {
			this.activeComposite.setVisible(false);
			this.activeComposite.element.remove();
		}
		this.activeComposite = composite;
		this.contentDomNode.append(composite.element);
		composite.setVisible(!this.domNode.hidden);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.activeComposite?.setVisible(visible);
	}

	get activeCompositeId(): string | undefined {
		return this.activeComposite?.id;
	}
}
