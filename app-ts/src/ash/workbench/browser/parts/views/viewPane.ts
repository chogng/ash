import "./views.css";
import { Emitter } from "../../../../base/common/event.js";
import { PaneView, type PaneViewOptions } from "../../../../base/browser/ui/splitview/paneView.js";
import type { IView } from "../../../common/views.js";

/** Runtime inputs supplied by a browser view container to every pane. */
export type IViewPaneOptions = PaneViewOptions;

/** Optional title content and actions projected together into a hosting Part. */
export interface PartTitleProjection {
	readonly content?: HTMLElement;
	readonly actions?: HTMLElement;
}

/** A titled, independently managed view hosted inside a workbench view container. */
export abstract class ViewPane extends PaneView implements IView {
	private visible = false;
	private readonly bodyVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeBodyVisibility = this.bodyVisibility.event;

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
		super.setCollapsed(collapsed);
		this.bodyVisibility.fire(!collapsed);
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.element.hidden = !visible;
		if (this.isExpanded()) this.bodyVisibility.fire(visible);
	}
}
