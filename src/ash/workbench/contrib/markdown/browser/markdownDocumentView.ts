import {
	Disposable,
} from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MarkdownPreview } from './markdownPreview.js';

export interface MarkdownDocumentViewOptions {
	readonly markdown?: string;
	readonly title?: string;
	readonly baseUri?: URI;
	readonly openLink: (href: string) => void | Promise<void>;
}

/**
 * Workbench adapter for a sandboxed Markdown document preview.
 *
 * MarkdownPreview owns parsing and sanitization, and the Webview service tracks
 * its sandbox. Validated links reach the product through its opener callback.
 */
export class MarkdownDocumentView extends Disposable {
	private readonly preview: MarkdownPreview;
	private readonly openLink: (href: string) => void | Promise<void>;

	readonly element: HTMLIFrameElement;

	constructor(container: HTMLElement, options: MarkdownDocumentViewOptions, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.openLink = options.openLink;
		this.preview = this._register(instantiation.createInstance(MarkdownPreview, container, {
			markdown: options.markdown,
			title: options.title,
			baseUri: options.baseUri,
		}));
		this.element = this.preview.element;
		this.element.classList.add('ash-markdown-document-view');
		this._register(this.preview.onDidOpenLink((href) => {
			void Promise.resolve(this.openLink(href)).catch((error: unknown) => {
				console.error('Unable to open Markdown link', error);
			});
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
		if (this.isDisposed) {
			throw new ReferenceError('MarkdownDocumentView is already disposed');
		}
	}
}
