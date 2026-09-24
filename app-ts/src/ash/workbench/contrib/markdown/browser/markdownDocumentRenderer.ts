import {
	Disposable,

	toDisposable,
} from "../../../../base/common/lifecycle.js";
import { MarkdownPreview } from "../../../../platform/markdown/browser/markdownPreview.js";

export interface MarkdownDocumentViewOptions {
	readonly markdown?: string;
	readonly title?: string;
	readonly openLink: (href: string) => void | Promise<void>;
}

/**
 * Workbench adapter for a sandboxed Markdown document preview.
 *
 * The platform component owns parsing, sanitization, and iframe isolation;
 * this view owns the product link-opening policy and editor-compatible shape.
 */
export class MarkdownDocumentView extends Disposable {
	private readonly preview: MarkdownPreview;
	private readonly openLink: (href: string) => void | Promise<void>;
	private active = true;

	readonly element: HTMLIFrameElement;

	constructor(container: HTMLElement, options: MarkdownDocumentViewOptions) {
		super();
		this.openLink = options.openLink;
		this.preview = this._register(new MarkdownPreview(container, {
			markdown: options.markdown,
			title: options.title,
		}));
		this.element = this.preview.element;
		this.element.classList.add("ash-markdown-document-view");
		this._register(this.preview.onDidOpenLink((href) => {
			void Promise.resolve(this.openLink(href)).catch((error: unknown) => {
				console.error("Unable to open Markdown link", error);
			});
		}));
		this._register(toDisposable(() => {
			this.active = false;
		}));
	}

	setMarkdown(markdown: string): void {
		this.requireActive();
		this.preview.setMarkdown(markdown);
	}

	focus(): void {
		this.requireActive();
		this.preview.focus();
	}

	private requireActive(): void {
		if (!this.active) {
			throw new ReferenceError("MarkdownDocumentView is already disposed");
		}
	}
}
