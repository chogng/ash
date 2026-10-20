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
interface LineGroup {
	first: MeasuredLine;
	top: number;
	bottom: number;
}

/**
 * The page stack fragments one editable DOM in model order. Empty spacers carry
 * geometry only: no page-local models, text identities, cloned editors or history.
 * Each block is measured after preceding breaks, so table cells and nested lists
 * consume their actual browser height rather than a sum of parallel cell lines.
 */
export class DocumentPageView extends Disposable {
	private viewport: HTMLDivElement | undefined;
	private shell: HTMLDivElement | undefined;
	private flow: HTMLDivElement | undefined;
	private backgrounds: HTMLDivElement | undefined;
	private paper: ReturnType<typeof documentPageDimensions>;
	private document: DocumentNode | undefined;
	private zoom = 1;

	constructor(private readonly container: HTMLDivElement, onMetricsChanged: () => void) {
		super();
		this._register(toDisposable(() => this.clear()));
		this._register(addDisposableListener(container, 'load', onMetricsChanged, true));
		const fonts = container.ownerDocument.fonts;
		if (fonts) this._register(addDisposableListener(fonts, 'loadingdone', onMetricsChanged));
	}

	clear(): void {
		this.viewport = this.shell = this.flow = this.backgrounds = undefined;
		this.paper = this.document = undefined;
		this.container.classList.remove('ash-document-paged');
	}

	render(fragment: DocumentFragment, document: DocumentNode): void {
		this.document = document;
		this.paper = documentPageDimensions(document);
		this.container.classList.toggle('ash-document-paged', !!this.paper);
		for (const image of fragment.querySelectorAll<HTMLElement>('.stanza-document-inline-image')) {
			image.style.maxHeight = this.paper ? `${this.paper.height - 2 * this.paper.margin}px` : '';
		}
		if (!this.paper) {
			this.viewport = this.shell = this.flow = this.backgrounds = undefined;
			this.container.replaceChildren(fragment);
			return;
		}
		const { width, margin } = this.paper;
		this.shell = h(this.container.ownerDocument, 'div');
		this.shell.className = 'ash-document-page-stack';
		this.shell.style.width = `${width}px`;
		this.viewport = h(this.container.ownerDocument, 'div');
		this.viewport.className = 'ash-document-page-viewport';
		this.backgrounds = h(this.container.ownerDocument, 'div');
		this.backgrounds.className = 'ash-document-page-backgrounds';
		this.backgrounds.setAttribute('aria-hidden', 'true');
		this.flow = h(this.container.ownerDocument, 'div');
		this.flow.className = 'ash-document-page-flow';
		this.flow.style.width = `${width - 2 * margin}px`;
		this.flow.style.left = this.flow.style.top = `${margin}px`;
		this.flow.append(fragment);
		this.shell.append(this.backgrounds, this.flow);
		this.viewport.append(this.shell);
		this.container.replaceChildren(this.viewport);
		this.setZoom(this.zoom);
		this.layout();
	}

	setZoom(zoom: number): void {
		this.zoom = zoom;
		if (!this.shell || !this.viewport || !this.paper) return;
		// Transform only the painted view. CSS zoom changes Chromium's table and
		// line-height rounding, which can otherwise move glyphs across page edges.
		this.shell.style.transform = `scale(${zoom})`;
		this.shell.dataset.pageZoom = String(zoom);
		this.viewport.style.width = `${this.paper.width * zoom}px`;
		this.viewport.style.height = `${parseFloat(this.shell.style.height || '0') * zoom}px`;
	}

	/** Called outside composition; the Widget restores the active model selection. */
	layout(): void {
		if (this.isDisposed || !this.paper || !this.flow || !this.shell || !this.backgrounds) return;
		const { width, height, margin } = this.paper;
		for (const gap of this.flow.querySelectorAll('.ash-document-page-gap')) gap.remove();
		// Merge only DOM Text siblings; marks, decorations and event owners survive.
		for (const run of this.flow.querySelectorAll('[data-text-node-id]')) run.normalize();
		const stride = height + 24;
		const bodyHeight = height - 2 * margin;
		const units = this.getUnits(this.flow, null);
		let count = 1;
		for (const [index, unit] of units.entries()) {
			// Native scroll anchoring or focus reveal can move the viewport during
			// reflow. Compare each unit with the current flow origin, not a stale screen Y.
			const origin = this.flow.getBoundingClientRect().top;
			if (unit.classList.contains('stanza-document-table-row')) this.layoutRow(unit, origin, stride, bodyHeight);
			else this.layoutBlock(unit, units, index, origin, stride, bodyHeight);
			const bottom = (unit.getBoundingClientRect().bottom - this.flow.getBoundingClientRect().top) / this.zoom;
			count = Math.max(count, Math.floor(Math.max(0, bottom - 0.5) / stride) + 1);
		}
		this.shell.style.height = `${count * stride - 24}px`;
		this.shell.dataset.pageCount = String(count);
		this.setZoom(this.zoom);
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
			this.renderRunningText(element, index, count, margin);
		}
	}

	private layoutBlock(unit: HTMLElement, units: readonly HTMLElement[], unitIndex: number, origin: number, stride: number, bodyHeight: number): void {
		const lines = this.groupLines(this.measureLines(unit));
		if (!lines.length) return;
		const first = lines[0]!;
		const start = (first.top - origin) / this.zoom;
		const end = (lines.at(-1)!.bottom - origin) / this.zoom;
		const page = Math.floor(start / stride);
		let shift = 0;
		const breaks: { line: MeasuredLine; height: number; }[] = [];
		let requiredEnd = end;
		if (unit.dataset.keepWithNext === 'true') {
			// Resolve the entire keep chain before moving its first paragraph. A later
			// member must not move independently and leave the first heading behind.
			for (let nextIndex = unitIndex + 1; nextIndex < units.length; nextIndex++) {
				const next = units[nextIndex]!;
				if (next.dataset.pageBreakBefore === 'true') break;
				const nextLines = this.groupLines(this.measureLines(next));
				const chained = next.dataset.keepWithNext === 'true';
				const required = next.dataset.keepTogether === 'true' || chained ? nextLines.at(-1) : nextLines[Math.min(1, nextLines.length - 1)];
				if (required) requiredEnd = (required.bottom - origin) / this.zoom;
				if (!chained || requiredEnd - start > bodyHeight) break;
			}
		}

		const manual = unit.dataset.pageBreakBefore === 'true';
		const keep = unit.dataset.keepTogether === 'true' || requiredEnd !== end;
		if (start > page * stride + 0.5 && (manual || (keep && requiredEnd - start <= bodyHeight && requiredEnd > page * stride + bodyHeight))) {
			shift = (page + 1) * stride - start;
			breaks.push({ line: first.first, height: shift });
		}
		let pageFirst = 0;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			const top = (line.top - origin) / this.zoom + shift;
			const bottom = (line.bottom - origin) / this.zoom + shift;
			const current = Math.floor(top / stride);
			if (bottom <= current * stride + bodyHeight + 0.5 || top <= current * stride + 0.5) continue;
			let split = index;
			if (unit.dataset.widowControl !== 'false' && lines.length > 1) {
				// Leave at least two lines on each side when the paragraph can satisfy it.
				if (index - pageFirst === 1) split = pageFirst;
				else if (lines.length - index === 1) {
					if (index - pageFirst > 2) split = index - 1;
					else if (end - start <= bodyHeight) split = pageFirst;
				}
			}
			const splitLine = lines[split]!;
			const gapHeight = (current + 1) * stride - ((splitLine.top - origin) / this.zoom + shift);
			breaks.push({ line: splitLine.first, height: gapHeight });
			shift += gapHeight;
			pageFirst = split;
		}
		// Later insertions must not invalidate earlier UTF-16 offsets in the same Text.
		for (const entry of breaks.reverse()) this.insertLineGap(entry.line, entry.height, entry.line === first.first ? unit : undefined);
	}

	private layoutRow(row: HTMLElement, origin: number, stride: number, bodyHeight: number): void {
		const rect = row.getBoundingClientRect();
		const start = (rect.top - origin) / this.zoom;
		const height = rect.height / this.zoom;
		const page = Math.floor(start / stride);
		const manual = row.querySelector('[data-page-break-before="true"]') !== null;
		if (!manual && height <= bodyHeight && start + height > page * stride + bodyHeight + 0.5 && start > page * stride + 0.5) {
			// A real table row is required here. An inline spacer in one cell would
			// move its neighbours by a different amount and corrupt page geometry.
			const gap = h(this.container.ownerDocument, 'tr');
			this.configureGap(gap, (page + 1) * stride - start);
			const cell = h(this.container.ownerDocument, 'td');
			cell.colSpan = row.children.length;
			gap.append(cell);
			row.before(gap);
			return;
		}
		if (!manual && height <= bodyHeight) return;
		// Cells share page boundaries, but each owns a column of content. Paginate
		// those columns independently; native row height remains their maximum.
		// Recursing through nested rows also keeps their parallel cells together.
		for (const cell of row.children) {
			const units = this.getUnits(cell as HTMLElement, row);
			for (const [index, unit] of units.entries()) {
				const currentOrigin = this.flow!.getBoundingClientRect().top;
				if (unit.classList.contains('stanza-document-table-row')) this.layoutRow(unit, currentOrigin, stride, bodyHeight);
				else this.layoutBlock(unit, units, index, currentOrigin, stride, bodyHeight);
			}
		}
	}

	private getUnits(root: HTMLElement, row: HTMLElement | null): HTMLElement[] {
		return [...root.querySelectorAll<HTMLElement>('.stanza-document-paragraph, .stanza-document-heading, .stanza-document-code-block, .stanza-document-table-row, .stanza-document-horizontal-rule')]
			.filter(unit => unit.parentElement?.closest('.stanza-document-table-row') === row);
	}

	private renderRunningText(page: HTMLElement, index: number, count: number, margin: number): void {
		page.replaceChildren();
		const attrs = this.document!.attrs;
		if (index === 0 && attrs.pageDifferentFirst === true) return;
		const even = attrs.pageDifferentEven === true && (index + 1) % 2 === 0;
		for (const [position, value] of [
			['header', even ? attrs.pageEvenHeader : attrs.pageHeader],
			['footer', even ? attrs.pageEvenFooter : attrs.pageFooter],
		] as const) {
			const text = h(page.ownerDocument, 'div');
			text.className = `ash-document-page-${position}`;
			text.textContent = String(value ?? '');
			text.style.insetInline = `${margin}px`;
			text.style[position === 'header' ? 'top' : 'bottom'] = `${margin / 3}px`;
			if (position === 'footer' && attrs.pageNumbers === true) {
				const number = h(page.ownerDocument, 'span');
				number.className = 'ash-document-page-number';
				number.textContent = `${index + 1} / ${count}`;
				text.append(number);
			}
			page.append(text);
		}
	}

	private measureLines(root: HTMLElement): MeasuredLine[] {
		const lines: MeasuredLine[] = [];
		const walker = root.ownerDocument.createTreeWalker(root, 5 /* Element | Text */);
		let order = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode;
			order++;
			if (node.parentElement?.closest('.ash-document-page-gap')) continue;
			if (node.nodeType === 3 && node.textContent && node.parentElement?.closest('[data-text-node-id]')) {
				const range = root.ownerDocument.createRange();
				range.selectNodeContents(node);
				for (const rect of range.getClientRects()) {
					if (rect.width > 0 && rect.height > 0) lines.push({ node: node as Text, order, top: rect.top, bottom: rect.bottom });
				}
			} else if (node.nodeType === 1 && (node as HTMLElement).matches('textarea, img, br, [data-inline-node-id]')) {
				const rect = (node as HTMLElement).getBoundingClientRect();
				if (rect.height > 0) lines.push({ node: node as HTMLElement, order, top: rect.top, bottom: rect.bottom });
			}
		}
		if (!lines.length) {
			const rect = root.getBoundingClientRect();
			if (rect.height > 0) lines.push({ node: root, order: 0, top: rect.top, bottom: rect.bottom });
		}
		return lines;
	}

	private groupLines(lines: readonly MeasuredLine[]): LineGroup[] {
		const groups: LineGroup[] = [];
		for (const line of [...lines].sort((a, b) => a.top - b.top || a.order - b.order)) {
			const group = groups.at(-1);
			if (group && line.top < group.bottom - 1 && line.bottom > group.top + 1) {
				group.top = Math.min(group.top, line.top);
				group.bottom = Math.max(group.bottom, line.bottom);
				if (line.order < group.first.order) group.first = line;
			} else groups.push({ first: line, top: line.top, bottom: line.bottom });
		}
		return groups;
	}

	private configureGap(gap: HTMLElement, height: number): void {
		gap.className = 'ash-document-page-gap';
		gap.contentEditable = 'false';
		gap.setAttribute('aria-hidden', 'true');
		gap.style.height = `${height}px`;
	}

	private insertLineGap(line: MeasuredLine, height: number, block?: HTMLElement): void {
		const gap = h(this.container.ownerDocument, 'span');
		this.configureGap(gap, height);
		if (block) block.prepend(gap);
		else if (line.node.nodeType === 3) {
			const range = this.container.ownerDocument.createRange();
			range.setStart(line.node, this.lineStartOffset(line));
			range.collapse(true);
			range.insertNode(gap);
		} else line.node.parentNode!.insertBefore(gap, line.node);
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
