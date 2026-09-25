import { h } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { BreadcrumbsModel } from "./breadcrumbsModel.js";
import type { EditorInput } from "./editorInput.js";

/** Renders the active editor's resource path in one group title. */
export class EditorBreadcrumbsControl extends Disposable {
	readonly domNode: HTMLElement;

	constructor(container: HTMLElement) {
		super();
		this.domNode = h(container.ownerDocument, "nav");
		this.domNode.className = "ash-editor-breadcrumbs";
		this.domNode.setAttribute("aria-label", "Editor breadcrumbs");
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	setInput(input: EditorInput | undefined): void {
		this.domNode.replaceChildren();
		if (!input) {
			this.domNode.hidden = true;
			return;
		}
		const elements = new BreadcrumbsModel(input.resource, input.label).getElements();
		for (const [index, element] of elements.entries()) {
			if (index > 0) {
				const separator = h(this.domNode.ownerDocument, "span");
				separator.className = "ash-editor-breadcrumb-separator";
				separator.setAttribute("aria-hidden", "true");
				separator.textContent = "›";
				this.domNode.append(separator);
			}
			const item = h(this.domNode.ownerDocument, "span");
			item.className = "ash-editor-breadcrumb-item";
			item.textContent = element.label;
			if (index === elements.length - 1) item.setAttribute("aria-current", "page");
			this.domNode.append(item);
		}
		this.domNode.title = input.resource.toString();
		this.domNode.hidden = false;
	}
}
