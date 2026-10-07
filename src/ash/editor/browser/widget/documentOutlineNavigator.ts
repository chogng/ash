import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { DocumentNodeId } from "../../common/model/document.js";
import type { DocumentOutline } from "../../common/model/documentOutline.js";
import { h, fragment as createFragment } from "../../../base/browser/dom.js";

export interface DocumentOutlineNavigatorOptions {
	readonly onSelect: (nodeId: DocumentNodeId) => void;
}

/** Browser-owned outline list that delegates selection back to its host. */
export class DocumentOutlineNavigator extends Disposable {
	readonly element: HTMLElement;
	private readonly list: HTMLOListElement;

	constructor(container: HTMLElement, private readonly options: DocumentOutlineNavigatorOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "nav");
		element.className = "stanza-document-outline";
		element.hidden = true;
		element.setAttribute("aria-label", "Document outline");
		const title = h(ownerDocument, "div");
		title.className = "stanza-document-outline-title";
		title.textContent = "Outline";
		const list = h(ownerDocument, "ol");
		list.className = "stanza-document-outline-list";
		element.append(title, list);
		this.element = element;
		this.list = list;
		container.append(element);
		this._register(toDisposable(() => element.remove()));
	}

	setOutline(outline: DocumentOutline): void {
		this.list.replaceChildren();
		this.element.hidden = outline.length === 0;
		const ownerDocument = this.element.ownerDocument;
		const fragment = createFragment(ownerDocument);
		for (const entry of outline) {
			const item = h(ownerDocument, "li");
			item.className = "stanza-document-outline-item";
			const button = h(ownerDocument, "button");
			button.type = "button";
			button.className = "stanza-document-outline-entry";
			button.dataset.nodeId = entry.nodeId;
			button.dataset.depth = String(entry.depth);
			button.style.paddingInlineStart = `${8 + entry.depth * 14}px`;
			button.textContent = entry.title || "Untitled heading";
			button.title = entry.title || "Untitled heading";
			button.addEventListener("mousedown", event => event.preventDefault());
			button.addEventListener("click", () => this.options.onSelect(entry.nodeId));
			item.append(button);
			fragment.append(item);
		}
		this.list.append(fragment);
	}
}
