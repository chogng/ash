import type { DocumentAttributes, DocumentNode } from './document.js';

/** Only user intent is persisted. Page fragments, zoom and page count belong to the view. */
export function validateDocumentPageAttributes(attrs: DocumentAttributes): void {
	if (attrs.pageOrientation !== undefined && !['portrait', 'landscape'].includes(String(attrs.pageOrientation))) throw new TypeError('Invalid page orientation');
	for (const key of ['pageHeader', 'pageFooter', 'pageEvenHeader', 'pageEvenFooter'] as const) {
		if (attrs[key] !== undefined && (typeof attrs[key] !== 'string' || String(attrs[key]).length > 500 || /[\r\n]/.test(String(attrs[key])))) throw new TypeError('Running text must be a single line of at most 500 characters');
	}
	for (const key of ['pageNumbers', 'pageDifferentFirst', 'pageDifferentEven'] as const) {
		if (attrs[key] !== undefined && typeof attrs[key] !== 'boolean') throw new TypeError('Invalid running text option');
	}
	if (attrs.pageSize !== undefined && !['continuous', 'a4', 'letter'].includes(String(attrs.pageSize))) throw new TypeError('Invalid document page size');
	if (attrs.pageMargin !== undefined && (typeof attrs.pageMargin !== 'number' || !Number.isFinite(attrs.pageMargin) || attrs.pageMargin < 18 || attrs.pageMargin > 144)) throw new TypeError('Page margins must be from 18 to 144 points');
}

export function documentPageDimensions(document: DocumentNode): { width: number; height: number; margin: number; } | undefined {
	if (document.attrs.pageSize !== 'a4' && document.attrs.pageSize !== 'letter') return undefined;
	// CSS pixels at 96 dpi. Screen zoom must never change these layout measurements.
	const width = document.attrs.pageSize === 'a4' ? 210 * 96 / 25.4 : 8.5 * 96;
	const height = document.attrs.pageSize === 'a4' ? 297 * 96 / 25.4 : 11 * 96;
	return {
		width: document.attrs.pageOrientation === 'landscape' ? height : width,
		height: document.attrs.pageOrientation === 'landscape' ? width : height,
		margin: Number(document.attrs.pageMargin ?? 72) * 96 / 72,
	};
}

/** Paragraph rules are persistent intent; automatic page gaps never enter the codec. */
export function validateDocumentPaginationAttributes(attrs: DocumentAttributes): void {
	for (const key of ['pageBreakBefore', 'keepWithNext', 'keepTogether', 'widowControl'] as const) {
		if (attrs[key] !== undefined && typeof attrs[key] !== 'boolean') throw new TypeError(`Invalid paragraph pagination rule '${key}'`);
	}
}
