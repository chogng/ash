import { compositePanelId, compositeTabId } from "../compositeBar.js";
import { Emitter } from "../../../../base/common/event.js";
import { localize } from "../../../services/localization/common/localizationService.js";
import { ViewPaneContainer, type ViewPaneContainerOptions } from "./viewPaneContainer.js";
import type { PartTitleProjection, ViewPane } from "./viewPane.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";

export interface PaneCompositeOptions extends ViewPaneContainerOptions {
	readonly paneHeaders?: PaneHeaderVisibility;
	readonly paneLayout?: PaneLayout;
	readonly mergeViewWithContainerWhenSingleView?: boolean;
}

export type PaneHeaderVisibility = "visible" | "hidden";
export type PaneLayout = "stack" | "fill";

/**
 * Activatable Composite whose content is assembled from registered ViewPanes.
 *
 * Parts retain instances while switching so pane visibility, focus, and
 * contribution-owned state survive temporary deactivation.
 */
export class PaneComposite extends ViewPaneContainer {
	title: string;
	private readonly titleChange = this._register(new Emitter<void>());
	readonly onDidChangeTitle = this.titleChange.event;
	private mergedPane: ViewPane | undefined;
	private mergedPaneWasCollapsed = false;

	constructor(container: HTMLElement, options: PaneCompositeOptions, @IStorageService storageService: IStorageService) {
		super(container, options, storageService);
		this.title = localize(options.localizationService, options.viewContainer.localizationKey, options.viewContainer.title);
		this.element.classList.add("ash-pane-composite");
		this.element.classList.toggle("ash-pane-composite-pane-headers-hidden", options.paneHeaders === "hidden");
		this.element.classList.toggle("ash-pane-composite-pane-layout-fill", options.paneLayout === "fill");
		this.element.setAttribute("aria-label", this.title);
		this.element.id = compositePanelId(options.viewContainer.location, options.viewContainer.id);
		this.element.setAttribute("role", "tabpanel");
		this.element.setAttribute("aria-labelledby", compositeTabId(options.viewContainer.location, options.viewContainer.id));
		if (options.mergeViewWithContainerWhenSingleView) {
			this._register(options.model.onDidChangeVisibleViewDescriptors(() => this.updateMergedPane()));
			this.updateMergedPane();
		}
	}

	getOptimalWidth(): number | undefined {
		return undefined;
	}

	getTitle(): string {
		const paneTitle = this.mergedPane?.paneTitle;
		return paneTitle && paneTitle !== this.title ? `${this.title}: ${paneTitle}` : this.title;
	}

	setMergedTitleActionsHost(host?: HTMLElement): void {
		this.mergedPane?.setHeaderActionsHost(host);
	}

	private updateMergedPane(): void {
		const pane = this.panes.length === 1 ? this.panes[0] : undefined;
		if (pane === this.mergedPane) return;
		if (this.mergedPane) {
			this.mergedPane.setHeaderVisible(true);
			if (this.mergedPaneWasCollapsed) this.mergedPane.setExpanded(false);
		}
		this.mergedPane = pane;
		this.mergedPaneWasCollapsed = pane?.isExpanded() === false;
		if (pane) {
			pane.setHeaderVisible(false);
			pane.setExpanded(true);
		}
		this.titleChange.fire();
	}

	get partTitleProjection(): PartTitleProjection | undefined {
		const projections = this.panes.map((pane) => pane.partTitleProjection).filter(
			(projection): projection is PartTitleProjection => projection !== undefined,
		);
		if (projections.length > 1) {
			throw new Error("A PaneComposite may receive a title projection from only one visible View");
		}
		return projections[0];
	}
}
