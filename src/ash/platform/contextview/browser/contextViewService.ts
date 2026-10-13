import {
	ContextView,
	type ContextViewHideReason,
	type ContextViewOptions,
} from "../../../base/browser/ui/contextview/contextview.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import type { ILayoutService } from "../../layout/browser/layoutService.js";
import type { IContextViewService } from "./contextView.js";
import { getWindow, isNode } from '../../../base/browser/dom.js';
import { onWillUnregisterWindow } from '../../../base/browser/window.js';

/** Browser ContextView service scoped to one Workbench container. */
export class BrowserContextViewService
	extends Disposable
	implements IContextViewService {
	readonly container: HTMLElement;
	private readonly contextView: ContextView;

	constructor(container: HTMLElement, private readonly layoutService?: ILayoutService) {
		super();
		this.container = container;
		this.contextView = this._register(new ContextView(container));
		if (layoutService) {
			this._register(layoutService.onDidLayoutActiveContainer(() => this.layout()));
			this._register(onWillUnregisterWindow(({ window }) => {
				if (getWindow(this.contextView.element) !== window) return;
				this.hide();
				layoutService.mainContainer.append(this.contextView.element);
			}));
		}
	}

	show(options: ContextViewOptions): boolean {
		if (this.layoutService) {
			const targetWindow = isNode(options.anchor) ? getWindow(options.anchor) :
				'targetWindow' in options.anchor ? (options.anchor as { targetWindow: Window }).targetWindow : getWindow(this.layoutService.activeContainer);
			const container = this.layoutService.getContainer(targetWindow);
			if (this.contextView.element.parentElement !== container) {
				this.hide();
				// Mount under the window's themed root, so adopted menus and hovers inherit its tokens.
				container.append(this.contextView.element);
			}
		}
		return this.contextView.show(options);
	}

	hide(reason?: ContextViewHideReason): void {
		this.contextView.hide(reason);
	}

	layout(): void {
		this.contextView.layout();
	}
}
