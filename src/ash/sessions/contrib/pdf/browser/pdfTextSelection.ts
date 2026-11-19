import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { binarySearch2 } from '../../../../base/common/arrays.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { PdfPage, PdfRect } from '../../../../platform/pdf/common/pdfService.js';

interface PdfSelectionLine {
	readonly first: number;
	readonly end: number;
	readonly bounds: PdfRect;
	verticalBounds?: Pick<PdfRect, 'y' | 'height'>;
}

/** Paints the native selection over the page raster without changing the DOM text range. */
export class PdfTextSelection extends Disposable {
	private lines: readonly PdfSelectionLine[] | undefined;
	private raster: ImageData | null | undefined;

	constructor(
		private readonly page: PdfPage,
		private readonly stage: HTMLElement,
		private readonly content: HTMLElement,
		private readonly highlight: HTMLElement,
	) {
		super();
		const update = this._register(new AnimationFrameScheduler(getWindow(content), () => this.paint()));
		this._register(addDisposableListener(content.ownerDocument, 'selectionchange', () => update.schedule()));
		update.schedule();
	}

	private paint(): void {
		const document = this.content.ownerDocument;
		const selection = document.getSelection();
		const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : undefined;
		if (!range?.intersectsNode(this.content)) {
			this.raster = undefined;
			if (this.highlight.firstChild) { this.highlight.replaceChildren(); }
			return;
		}
		// One span per PDF character keeps this lookup independent of DOM text measurements.
		const first = ~binarySearch2(this.page.characters.length, index => {
			const node = this.content.children[index].firstChild as Text;
			const endsAtStart = node === range.startContainer && node.length === range.startOffset;
			return endsAtStart || range.comparePoint(node, node.length) < 0 ? -1 : 1;
		});
		const end = ~binarySearch2(this.page.characters.length, index => {
			const node = this.content.children[index].firstChild as Text;
			const startsAtEnd = node === range.endContainer && range.endOffset === 0;
			return startsAtEnd || range.comparePoint(node, 0) > 0 ? 1 : -1;
		});

		const bands = document.createDocumentFragment();
		this.lines ??= selectionLines(this.page);
		for (const line of this.lines) {
			if (line.end <= first) { continue; }
			if (line.first >= end) { break; }
			const horizontal = first <= line.first && end >= line.end
				? line.bounds
				: this.selectedBounds(Math.max(first, line.first), Math.min(end, line.end));
			if (!horizontal) { continue; }

			// Use the whole printed line for vertical alignment, even when only a short piece is selected.
			if (!line.verticalBounds) {
				if (this.raster === undefined) { this.raster = this.readRaster(); }
				line.verticalBounds = this.raster ? alignToInk(line.bounds, this.raster) ?? line.bounds : line.bounds;
			}
			const vertical = line.verticalBounds;
			const band = document.createElement('div');
			band.style.left = `${horizontal.x * 100}%`;
			band.style.width = `${horizontal.width * 100}%`;
			band.style.top = `${vertical.y * 100}%`;
			band.style.height = `${vertical.height * 100}%`;
			bands.append(band);
		}
		this.highlight.replaceChildren(bands);
	}

	private selectedBounds(first: number, end: number): PdfRect | undefined {
		let bounds: PdfRect | undefined;
		for (let index = first; index < end; index++) {
			const character = this.page.characters[index];
			if (character.bounds.width && character.bounds.height && character.text.trim()) {
				bounds = bounds ? union(bounds, character.bounds) : character.bounds;
			}
		}
		return bounds;
	}

	private readRaster(): ImageData | null {
		const image = this.stage.querySelector<HTMLImageElement>(':scope > img');
		if (!image?.naturalWidth) { return null; }
		// Sampling is lazy and bounded. A raster sharpen can reuse the normalized line alignment.
		const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
		const canvas = this.content.ownerDocument.createElement('canvas');
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		try {
			const context = canvas.getContext('2d', { willReadFrequently: true });
			if (!context) { return null; }
			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			return context.getImageData(0, 0, canvas.width, canvas.height);
		} catch {
			return null;
		} finally {
			canvas.width = canvas.height = 0;
		}
	}
}

function selectionLines(page: PdfPage): PdfSelectionLine[] {
	const lines: PdfSelectionLine[] = [];
	let line: PdfSelectionLine | undefined;
	let previous: PdfRect | undefined;
	let wordSpace = 0;
	const pageAspectRatio = page.height / page.width;
	for (let index = 0; index < page.characters.length; index++) {
		const { bounds, text } = page.characters[index];
		// PDFium can report a line break or a space with a zero-height box.
		if (text === '\r' || text === '\n') {
			if (line) { lines.push(line); }
			line = previous = undefined;
			wordSpace = 0;
			continue;
		}
		if (!text.trim()) {
			wordSpace += bounds.width;
			continue;
		}
		if (!bounds.width || !bounds.height) { continue; }
		if (line && previous && onSameLine(line.bounds, previous, bounds, wordSpace, pageAspectRatio)) {
			line = { first: line.first, end: index + 1, bounds: union(line.bounds, bounds) };
		} else {
			if (line) { lines.push(line); }
			line = { first: index, end: index + 1, bounds };
		}
		previous = bounds;
		wordSpace = 0;
	}
	if (line) { lines.push(line); }
	return lines;
}

function union(left: PdfRect, right: PdfRect): PdfRect {
	const x = Math.min(left.x, right.x);
	const y = Math.min(left.y, right.y);
	return { x, y, width: Math.max(left.x + left.width, right.x + right.width) - x, height: Math.max(left.y + left.height, right.y + right.height) - y };
}

function onSameLine(line: PdfRect, previous: PdfRect, next: PdfRect, wordSpace: number, pageAspectRatio: number): boolean {
	// A period or dash can sit outside the previous glyph's ink box but still belong to the line.
	const lineHeight = Math.max(line.height, next.height);
	const verticalOffset = Math.abs(line.y + line.height / 2 - (next.y + next.height / 2));
	const gap = Math.max(previous.x - next.x - next.width, next.x - previous.x - previous.width);
	const gapLimit = lineHeight * pageAspectRatio * 1.25;
	// Account for an explicit space without joining distant blocks separated by whitespace.
	return verticalOffset <= lineHeight * 0.65 && gap <= gapLimit + Math.min(wordSpace, gapLimit);
}

function alignToInk(bounds: PdfRect, raster: ImageData): Pick<PdfRect, 'y' | 'height'> | undefined {
	const { data, width, height } = raster;
	const left = Math.max(0, Math.floor(bounds.x * width));
	const right = Math.min(width, Math.ceil((bounds.x + bounds.width) * width));
	const lineHeight = bounds.height * height;
	if (lineHeight < 4 || right - left < lineHeight * 2) { return; }

	// OCR bounds can sit below or above the visible ink. Limit the search to the neighborhood of the line.
	const top = Math.max(0, Math.floor(bounds.y * height - lineHeight * 0.35));
	const bottom = Math.min(height, Math.ceil((bounds.y + bounds.height) * height + lineHeight * 0.35));
	const rows = new Uint16Array(Math.max(0, bottom - top));
	const stride = Math.max(1, Math.floor((right - left) / 256));
	let peak = 0;
	for (let y = top; y < bottom; y++) {
		let count = 0;
		for (let x = left; x < right; x += stride) {
			const offset = (y * width + x) * 4;
			if (data[offset + 3] >= 128 && data[offset] + data[offset + 1] + data[offset + 2] < 480) { count++; }
		}
		rows[y - top] = count;
		peak = Math.max(peak, count);
	}
	const minimum = Math.max(2, Math.ceil((right - left) / stride * 0.04), Math.ceil(peak * 0.17));
	let first = -1;
	let last = -1;
	for (let row = 0; row < rows.length; row++) {
		if (rows[row] < minimum) { continue; }
		if (first === -1) { first = row; }
		last = row;
	}
	const inkHeight = last - first + 1;
	// Continuous dark backgrounds and ambiguous projections keep the PDF's original geometry.
	if (first <= 0 || last === rows.length - 1 || inkHeight < lineHeight * 0.5 || inkHeight > lineHeight * 1.35) { return; }

	const bandHeight = Math.max(lineHeight, inkHeight);
	const center = top + (first + last + 1) / 2;
	return { y: Math.max(0, Math.min(height - bandHeight, center - bandHeight / 2)) / height, height: bandHeight / height };
}
