import {
	ViewPane,
	type IViewPaneOptions,
} from "./viewPane.js";
import { h } from "../../../../base/browser/dom.js";

/** Informational pane used while a View Container awaits its full feature. */
export class PlaceholderViewPane extends ViewPane {
	constructor(
		message: string,
		container: HTMLElement,
		options: IViewPaneOptions,
	) {
		super(container, options);
		const placeholder = h(container.ownerDocument, "p");
		placeholder.className = "ash-view-pane-placeholder";
		placeholder.textContent = message;
		this.contentElement.append(placeholder);
	}
}
