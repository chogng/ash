import { h } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { EditorInput } from "./editorInput.js";

/** Resource-path projection for the active editor in one group title. */
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
		const path = safelyDecodePath(input.resource.path);
		const segments = path.split("/").filter(Boolean);
		if (input.resource.authority) segments.unshift(input.resource.authority);
		if (segments.length === 0) segments.push(input.label?.trim() || input.resource.toString());
		for (const [index, segment] of segments.entries()) {
			if (index > 0) {
				const separator = h(this.domNode.ownerDocument, "span");
				separator.className = "ash-editor-breadcrumb-separator";
				separator.setAttribute("aria-hidden", "true");
				separator.textContent = "›";
				this.domNode.append(separator);
			}
			const item = h(this.domNode.ownerDocument, "span");
			item.className = "ash-editor-breadcrumb-item";
			item.textContent = segment;
			if (index === segments.length - 1) item.setAttribute("aria-current", "page");
			this.domNode.append(item);
		}
		this.domNode.title = input.resource.toString();
		this.domNode.hidden = false;
	}
}

function safelyDecodePath(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}
