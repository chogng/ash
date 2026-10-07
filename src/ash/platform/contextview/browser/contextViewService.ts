import {
	ContextView,
	type ContextViewHideReason,
	type ContextViewOptions,
} from "../../../base/browser/ui/contextview/contextview.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import type { ILayoutService } from "../../layout/browser/layoutService.js";
import type { IContextViewService } from "./contextView.js";

/** Browser ContextView service scoped to one Workbench container. */
export class BrowserContextViewService
	extends Disposable
	implements IContextViewService {
	readonly container: HTMLElement;
	private readonly contextView: ContextView;

	constructor(container: HTMLElement, layoutService?: ILayoutService) {
		super();
		this.container = container;
		this.contextView = this._register(new ContextView(container));
		if (layoutService) {
			this._register(layoutService.onDidLayoutActiveContainer(() => this.layout()));
		}
	}

	show(options: ContextViewOptions): boolean {
		return this.contextView.show(options);
	}

	hide(reason?: ContextViewHideReason): void {
		this.contextView.hide(reason);
	}

	layout(): void {
		this.contextView.layout();
	}
}
