import "./views.css";
import { Emitter } from "../../../../base/common/event.js";
import { Pane, type IPaneOptions } from "../../../../base/browser/ui/splitview/paneview.js";
import type { IView } from "../../../common/views.js";

/** Runtime inputs supplied by a browser view container to every pane. */
export type IViewPaneOptions = IPaneOptions;

/** Optional title content and actions projected together into a hosting Part. */
export interface PartTitleProjection {
	readonly content?: HTMLElement;
	readonly actions?: HTMLElement;
}

/** A titled, independently managed view hosted inside a workbench view container. */
export abstract class ViewPane extends Pane implements IView {
	private visible = false;
	private readonly bodyVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeBodyVisibility = this.bodyVisibility.event;
	private readonly visibility = this._register(new Emitter<boolean>());
	public readonly onDidChangeVisibility = this.visibility.event;

	protected constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.element.classList.add("ash-view-pane");
		this.element.dataset.viewId = options.id;
		this.element.hidden = true;
	}

	/** Optional title content and actions projected into the hosting Pane Composite Part. */
	get partTitleProjection(): PartTitleProjection | undefined {
		return undefined;
	}

	/** Views with intrinsic content widths report them independently of the current allocation. */
	getOptimalWidth(): number {
		return 0;
	}

	isVisible(): boolean {
		return this.visible;
	}

	isBodyVisible(): boolean {
		return this.visible && this.isExpanded();
	}

	isExpanded(): boolean {
		return !this.isCollapsed();
	}

	setExpanded(expanded: boolean): boolean {
		const changed = expanded !== this.isExpanded();
		this.setCollapsed(!expanded);
		return changed;
	}

	override setCollapsed(collapsed: boolean): void {
		if (collapsed === this.isCollapsed()) return;
		const bodyWasVisible = this.isBodyVisible();
		super.setCollapsed(collapsed);
		if (bodyWasVisible !== this.isBodyVisible()) this.bodyVisibility.fire(this.isBodyVisible());
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.element.hidden = !visible;
		this.visibility.fire(visible);
		if (this.isExpanded()) this.bodyVisibility.fire(visible);
	}
}
