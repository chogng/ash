import './pageLayout.css';
import { addDisposableListener, h } from '../../../../../src/ash/base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../src/ash/base/common/lifecycle.js';
import type { DocumentNode } from '../../../common/model/document.js';
import { documentPageDimensions } from '../../../common/model/documentPageLayout.js';

interface MeasuredLine {
	readonly node: Text | HTMLElement;
	readonly order: number;
	readonly top: number;
	readonly bottom: number;
}

/**
 * One editable DOM follows model order down the page stack. Empty, non-editable gaps
 * separate measured lines; they never introduce model text, cloned editors or history.
 * Splitting a DOM Text retains its enclosing text ID, marks and link listeners.
 */
export class DocumentPageView extends Disposable {
	private shell: HTMLDivElement | undefined;
	private flow: HTMLDivElement | undefined;
	private backgrounds: HTMLDivElement | undefined;
	private paper: ReturnType<typeof documentPageDimensions>;
	private zoom = 1;

	constructor(private readonly container: HTMLDivElement, onMetricsChanged: () => void) {
		super();
		this._register(toDisposable(() => this.clear()));
		this._register(addDisposableListener(container, 'load', onMetricsChanged, true));
		const fonts = container.ownerDocument.fonts;
		if (fonts) this._register(addDisposableListener(fonts, 'loadingdone', onMetricsChanged));
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
		const { width, margin } = this.paper;
		this.shell = h(this.container.ownerDocument, 'div');
		this.shell.className = 'ash-document-page-stack';
		this.shell.style.width = `${width}px`;
		this.shell.style.zoom = String(this.zoom);
		this.backgrounds = h(this.container.ownerDocument, 'div');
		this.backgrounds.className = 'ash-document-page-backgrounds';
		this.backgrounds.setAttribute('aria-hidden', 'true');
		this.flow = h(this.container.ownerDocument, 'div');
		this.flow.className = 'ash-document-page-flow';
		this.flow.style.width = `${width - 2 * margin}px`;
		this.flow.style.left = this.flow.style.top = `${margin}px`;
		this.flow.append(fragment);
		this.shell.append(this.backgrounds, this.flow);
		this.container.replaceChildren(this.shell);
		this.layout();
	}

	setZoom(zoom: number): void {
		this.zoom = zoom;
		if (this.shell) this.shell.style.zoom = String(zoom);
	}

	/** The Widget calls this outside composition and restores any active model selection. */
	layout(): void {
		if (this.isDisposed || !this.paper || !this.flow || !this.shell || !this.backgrounds) return;
		const { width, height, margin } = this.paper;
		for (const gap of this.flow.querySelectorAll('.ash-document-page-gap')) gap.remove();
		// Merge only DOM Text siblings; marks, decorations and their event owners stay intact.
		for (const run of this.flow.querySelectorAll('[data-text-node-id]')) run.normalize();
		const origin = this.flow.getBoundingClientRect().top;
		const lines = this.measureLines();
		const groups: { first: MeasuredLine; top: number; bottom: number; }[] = [];
		for (const line of lines.sort((a, b) => a.top - b.top || a.order - b.order)) {
			const group = groups.at(-1);
			if (group && line.top < group.bottom - 1 && line.bottom > group.top + 1) {
				group.top = Math.min(group.top, line.top);
				group.bottom = Math.max(group.bottom, line.bottom);
				if (line.order < group.first.order) group.first = line;
			} else groups.push({ first: line, top: line.top, bottom: line.bottom });
		}
		const stride = height + 24;
		const bodyHeight = height - 2 * margin;
		const breaks: { line: MeasuredLine; height: number; }[] = [];
		let shift = 0;
		let count = 1;
		for (const group of groups) {
			const top = (group.top - origin) / this.zoom + shift;
			const bottom = (group.bottom - origin) / this.zoom + shift;
			let page = Math.floor(top / stride);
			if (bottom > page * stride + bodyHeight + 0.5 && top > page * stride + 0.5) {
				const gapHeight = (page + 1) * stride - top;
				breaks.push({ line: group.first, height: gapHeight });
				shift += gapHeight;
				page++;
			}
			count = Math.max(count, page + 1);
		}
		// Insert from the end so earlier UTF-16 offsets still refer to the original Text.
		for (const entry of breaks.reverse()) {
			const gap = h(this.container.ownerDocument, 'span');
			gap.className = 'ash-document-page-gap';
			gap.contentEditable = 'false';
			gap.setAttribute('aria-hidden', 'true');
			gap.style.height = `${entry.height}px`;
			if (entry.line.node.nodeType === 3) {
				const range = this.container.ownerDocument.createRange();
				range.setStart(entry.line.node, this.lineStartOffset(entry.line));
				range.collapse(true);
				range.insertNode(gap);
			} else entry.line.node.parentNode!.insertBefore(gap, entry.line.node);
		}
		this.shell.style.height = `${count * stride - 24}px`;
		this.shell.dataset.pageCount = String(count);
		while (this.backgrounds.childElementCount > count) this.backgrounds.lastElementChild!.remove();
		while (this.backgrounds.childElementCount < count) {
			const page = h(this.container.ownerDocument, 'div');
			page.className = 'ash-document-page';
			this.backgrounds.append(page);
		}
		for (const [index, page] of [...this.backgrounds.children].entries()) {
			const element = page as HTMLElement;
			element.style.top = `${index * stride}px`;
			element.style.width = `${width}px`;
			element.style.height = `${height}px`;
		}
	}

	private measureLines(): MeasuredLine[] {
		const lines: MeasuredLine[] = [];
		const walker = this.container.ownerDocument.createTreeWalker(this.flow!, 5 /* Element | Text */);
		let order = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode;
			order++;
			if (node.nodeType === 3 && node.textContent && node.parentElement?.closest('[data-text-node-id]')) {
				const range = this.container.ownerDocument.createRange();
				range.selectNodeContents(node);
				for (const rect of range.getClientRects()) {
					if (rect.width > 0 && rect.height > 0) lines.push({ node: node as Text, order, top: rect.top, bottom: rect.bottom });
				}
			} else if (node.nodeType === 1 && (node as HTMLElement).matches('textarea, img, hr, [data-inline-node-id]')) {
				const rect = (node as HTMLElement).getBoundingClientRect();
				if (rect.height > 0) lines.push({ node: node as HTMLElement, order, top: rect.top, bottom: rect.bottom });
			}
		}
		return lines;
	}

	private lineStartOffset(line: MeasuredLine): number {
		const text = line.node as Text;
		const range = this.container.ownerDocument.createRange();
		let low = 0;
		let high = text.length - 1;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			range.setStart(text, middle);
			range.setEnd(text, middle + 1);
			if (range.getBoundingClientRect().top >= line.top - 0.5) high = middle;
			else low = middle + 1;
		}
		return low;
	}
}
