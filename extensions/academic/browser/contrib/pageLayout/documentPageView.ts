import './pageLayout.css';
import { addDisposableListener, h } from '../../../../../src/ash/base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../src/ash/base/common/lifecycle.js';
import type { DocumentNode } from '../../../common/model/document.js';
import { documentPageDimensions } from '../../../common/model/documentPageLayout.js';

/**
 * Native column fragmentation keeps one editable DOM and one model point per text offset.
 * Range geometry, hit testing, selection and IME all use the browser's same fragments,
 * including a single paragraph spanning pages. No editable clones or synthetic line breaks.
 */
export class DocumentPageView extends Disposable {
	private shell: HTMLDivElement | undefined;
	private flow: HTMLDivElement | undefined;
	private backgrounds: HTMLDivElement | undefined;
	private paper: ReturnType<typeof documentPageDimensions>;
	private zoom = 1;

	constructor(private readonly container: HTMLDivElement) {
		super();
		// Font/image completion can change fragmentation without changing content version.
		this._register(toDisposable(() => this.clear()));
		this._register(addDisposableListener(container, 'load', () => this.measure(), true));
		this._register(addDisposableListener(container.ownerDocument.fonts, 'loadingdone', () => this.measure()));
	}

	clear(): void {
		this.shell = this.flow = this.backgrounds = undefined;
		this.paper = undefined;
		this.container.classList.remove('ash-document-paged');
	}

	render(fragment: DocumentFragment, document: DocumentNode): void {
		this.paper = documentPageDimensions(document);
		this.container.classList.toggle('ash-document-paged', !!this.paper);
		if (!this.paper) {
			this.shell = this.flow = this.backgrounds = undefined;
			this.container.replaceChildren(fragment);
			return;
		}
		const { width, height, margin } = this.paper;
		this.shell = h(this.container.ownerDocument, 'div');
		this.shell.className = 'ash-document-page-strip';
		this.shell.style.height = `${height}px`;
		this.shell.style.zoom = String(this.zoom);
		this.backgrounds = h(this.container.ownerDocument, 'div');
		this.backgrounds.className = 'ash-document-page-backgrounds';
		this.backgrounds.setAttribute('aria-hidden', 'true');
		this.flow = h(this.container.ownerDocument, 'div');
		this.flow.className = 'ash-document-page-flow';
		this.flow.style.width = `${width - 2 * margin}px`;
		this.flow.style.height = `${height - 2 * margin}px`;
		this.flow.style.left = this.flow.style.top = `${margin}px`;
		this.flow.style.columnWidth = `${width - 2 * margin}px`;
		this.flow.style.columnGap = `${2 * margin + 24}px`;
		this.flow.append(fragment);
		this.shell.append(this.backgrounds, this.flow);
		this.container.replaceChildren(this.shell);
		this.measure();
	}

	setZoom(zoom: number): void {
		this.zoom = zoom;
		if (this.shell) this.shell.style.zoom = String(zoom);
	}

	private measure(): void {
		if (this.isDisposed || !this.paper || !this.flow || !this.shell || !this.backgrounds) return;
		const { width, height, margin } = this.paper;
		const bodyWidth = width - 2 * margin;
		const stride = width + 24;
		// scrollWidth rounds to integer CSS pixels; tolerate that rounding at exact boundaries.
		const count = Math.max(1, Math.ceil((this.flow.scrollWidth - bodyWidth - 1) / stride) + 1);
		this.shell.style.width = `${count * stride - 24}px`;
		this.shell.dataset.pageCount = String(count);
		while (this.backgrounds.childElementCount > count) this.backgrounds.lastElementChild!.remove();
		while (this.backgrounds.childElementCount < count) {
			const page = h(this.container.ownerDocument, 'div');
			page.className = 'ash-document-page';
			this.backgrounds.append(page);
		}
		for (const [index, page] of [...this.backgrounds.children].entries()) {
			const element = page as HTMLElement;
			element.style.left = `${index * stride}px`;
			element.style.width = `${width}px`;
			element.style.height = `${height}px`;
		}
	}
}
