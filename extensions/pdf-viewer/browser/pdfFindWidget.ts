import { localize } from '../../../src/ash/nls.js';
import { addDisposableListener, h } from '../../../src/ash/base/browser/dom.js';
import { Button } from '../../../src/ash/base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Lxicon } from '../../../src/ash/base/common/lxicons.js';
import { defaultButtonStyles } from '../../../src/ash/platform/theme/browser/defaultStyles.js';
import type { PdfRenderedPage } from './pdfRenderer.js';

interface PdfMatch {
	readonly page: PdfRenderedPage;
	readonly range: Range;
}

const maximumMatches = 10_000;

/** Pane-owned find state. DOM ranges preserve text selection and never alter the PDF text nodes. */
export class PdfFindWidget extends Disposable {
	readonly element: HTMLDivElement;
	private readonly input: HTMLInputElement;
	private readonly status: HTMLSpanElement;
	private readonly previous: Button;
	private readonly next: Button;
	private pages: readonly PdfRenderedPage[] = [];
	private matches: PdfMatch[] = [];
	private overlays: HTMLElement[] = [];
	private current = -1;
	private limited = false;

	constructor(
		parent: HTMLElement,
		private readonly focusPages: () => void,
	) {
		super();
		const document = parent.ownerDocument;
		this.element = h(document, 'div');
		this.element.className = 'ash-pdf-find';
		this.element.hidden = true;
		this.element.setAttribute('role', 'search');
		this.element.setAttribute('aria-label', localize('pdf.viewer.find', 'Find in PDF'));
		this.input = h(document, 'input');
		this.input.type = 'search';
		this.input.className = 'ash-pdf-find-input';
		this.input.placeholder = localize('pdf.viewer.find', 'Find in PDF');
		this.input.setAttribute('aria-label', this.input.placeholder);
		this.input.maxLength = 1000;
		this.status = h(document, 'span');
		this.status.className = 'ash-pdf-find-status';
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-atomic', 'true');
		this.element.append(this.input, this.status);
		this.previous = this._register(
			new Button(this.element, {
				...defaultButtonStyles,
				label: localize('pdf.viewer.previousMatch', 'Previous match'),
				icon: Lxicon.chevronUp,
				iconOnly: true,
				size: 'small',
				onClick: () => this.move(-1),
			}),
		);
		this.next = this._register(
			new Button(this.element, {
				...defaultButtonStyles,
				label: localize('pdf.viewer.nextMatch', 'Next match'),
				icon: Lxicon.chevronDown,
				iconOnly: true,
				size: 'small',
				onClick: () => this.move(1),
			}),
		);
		this._register(
			new Button(this.element, {
				...defaultButtonStyles,
				label: localize('pdf.viewer.closeFind', 'Close search'),
				icon: Lxicon.close,
				iconOnly: true,
				size: 'small',
				onClick: () => this.close(),
			}),
		);
		parent.append(this.element);
		this._register(
			addDisposableListener(this.input, 'input', event => {
				if (!(event as InputEvent).isComposing) this.search();
			}),
		);
		this._register(addDisposableListener(this.input, 'compositionend', () => this.search()));
		this._register(
			addDisposableListener(this.element, 'keydown', event => {
				if (event.isComposing) return;
				if (event.key === 'Escape') this.close();
				else if (event.key === 'Enter') this.move(event.shiftKey ? -1 : 1);
				else return;
				event.preventDefault();
				event.stopPropagation();
			}),
		);
		this._register(
			toDisposable(() => {
				this.clearHighlights();
				this.matches = [];
				this.pages = [];
				this.element.remove();
			}),
		);
		this.updateStatus();
	}

	open(): void {
		this.element.hidden = false;
		this.input.focus();
		this.input.select();
		this.search();
	}

	private close(): void {
		this.element.hidden = true;
		this.clearHighlights();
		this.focusPages();
	}

	setPages(pages: readonly PdfRenderedPage[]): void {
		this.pages = pages;
		this.matches = [];
		this.current = -1;
		this.search();
	}

	setEnabled(enabled: boolean): void {
		this.input.disabled = !enabled;
		this.previous.enabled = enabled && this.matches.length > 0;
		this.next.enabled = enabled && this.matches.length > 0;
	}

	private search(): void {
		this.matches = [];
		this.current = -1;
		this.limited = false;
		const query = this.input.value.trim();
		if (query && !this.element.hidden) {
			// Treat input literally; whitespace can cross extracted line boundaries and text runs.
			const pattern = query
				.split(/\s+/u)
				.map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
				.join('\\s+');
			const expression = new RegExp(pattern, 'giu');
			outer: for (const page of this.pages) {
				for (const match of page.text.matchAll(expression)) {
					if (this.matches.length === maximumMatches) {
						this.limited = true;
						break outer;
					}
					const start = match.index;
					const end = start + match[0].length;
					const first = page.textRuns.find(run => run.start <= start && run.end > start);
					const last = page.textRuns.find(run => run.start < end && run.end >= end);
					if (!first?.element.firstChild || !last?.element.firstChild) continue;
					const range = page.element.ownerDocument.createRange();
					range.setStart(first.element.firstChild, start - first.start);
					range.setEnd(last.element.firstChild, end - last.start);
					this.matches.push({ page, range });
				}
			}
		}
		this.current = this.matches.length ? 0 : -1;
		this.layout();
		this.updateStatus();
		this.revealCurrent();
	}

	private move(direction: number): void {
		if (!this.matches.length) return;
		this.current = (this.current + direction + this.matches.length) % this.matches.length;
		this.layout();
		this.updateStatus();
		this.revealCurrent();
	}

	/** Recompute rectangles after text/canvas scaling, without replacing the search or selected result. */
	layout(): void {
		this.clearHighlights();
		if (this.element.hidden) return;
		const layers = new Map<PdfRenderedPage, HTMLElement>();
		for (const [index, match] of this.matches.entries()) {
			let layer = layers.get(match.page);
			if (!layer) {
				layer = h(match.page.element.ownerDocument, 'div');
				layer.className = 'ash-pdf-search-highlights';
				layer.setAttribute('aria-hidden', 'true');
				layers.set(match.page, layer);
				this.overlays.push(layer);
			}
			const bounds = match.page.element.getBoundingClientRect();
			for (const rect of match.range.getClientRects()) {
				if (!rect.width || !rect.height) continue;
				const highlight = h(layer.ownerDocument, 'div');
				highlight.className = 'ash-pdf-search-match';
				highlight.classList.toggle('current', index === this.current);
				highlight.style.left = `${(100 * (rect.left - bounds.left)) / bounds.width}%`;
				highlight.style.top = `${(100 * (rect.top - bounds.top)) / bounds.height}%`;
				highlight.style.width = `${(100 * rect.width) / bounds.width}%`;
				highlight.style.height = `${(100 * rect.height) / bounds.height}%`;
				layer.append(highlight);
			}
		}
		for (const [page, layer] of layers) page.element.append(layer);
	}

	private revealCurrent(): void {
		this.matches[this.current]?.page.element.querySelector('.ash-pdf-search-match.current')?.scrollIntoView({ block: 'center', inline: 'nearest' });
	}

	private updateStatus(): void {
		const match = this.matches[this.current];
		this.status.textContent = !this.input.value.trim()
			? ''
			: match
				? this.limited
					? localize('pdf.viewer.matchesLimited', '{0} of the first {1} matches · page {2}', this.current + 1, maximumMatches, match.page.pageNumber)
					: localize('pdf.viewer.matches', '{0} of {1} · page {2}', this.current + 1, this.matches.length, match.page.pageNumber)
				: this.pages.some(page => page.text.trim())
					? localize('pdf.viewer.noMatches', 'No matches')
					: localize('pdf.viewer.noSearchableText', 'No searchable text in this PDF');
		this.setEnabled(!this.input.disabled);
	}

	private clearHighlights(): void {
		for (const overlay of this.overlays) overlay.remove();
		this.overlays = [];
	}
}
