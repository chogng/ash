import type { DocumentAttributes, DocumentNode } from './document.js';

/** Only user intent is persisted. Page fragments, zoom and page count belong to the view. */
export function validateDocumentPageAttributes(attrs: DocumentAttributes): void {
	if (attrs.pageSize !== undefined && !['continuous', 'a4', 'letter'].includes(String(attrs.pageSize))) throw new TypeError('Invalid document page size');
	if (attrs.pageMargin !== undefined && (typeof attrs.pageMargin !== 'number' || !Number.isFinite(attrs.pageMargin) || attrs.pageMargin < 18 || attrs.pageMargin > 144)) throw new TypeError('Page margins must be from 18 to 144 points');
}

export function documentPageDimensions(document: DocumentNode): { width: number; height: number; margin: number; } | undefined {
	if (document.attrs.pageSize !== 'a4' && document.attrs.pageSize !== 'letter') return undefined;
	// CSS pixels at 96 dpi. Screen zoom must never change these layout measurements.
	return {
		width: document.attrs.pageSize === 'a4' ? 210 * 96 / 25.4 : 8.5 * 96,
		height: document.attrs.pageSize === 'a4' ? 297 * 96 / 25.4 : 11 * 96,
		margin: Number(document.attrs.pageMargin ?? 72) * 96 / 72,
	};
}
