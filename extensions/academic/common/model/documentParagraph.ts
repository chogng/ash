import type { DocumentAttributes } from './document.js';

/** Persistent paragraph measurements use points, independent of viewport zoom and UI spacing tokens. */
export interface DocumentParagraphAttributes {
	readonly textAlign?: 'start' | 'center' | 'end' | 'justify';
	readonly lineSpacing?: number;
	readonly spaceBefore?: number;
	readonly spaceAfter?: number;
}

/** Existing continuous-document defaults; absent attributes keep old documents visually compatible. */
export const defaultDocumentParagraphAttributes: Required<DocumentParagraphAttributes> = Object.freeze({
	textAlign: 'start', lineSpacing: 1.6, spaceBefore: 0, spaceAfter: 9,
});

/** Schema validation covers files, clipboard fragments, remote transactions and local commands alike. */
export function validateDocumentParagraphAttributes(attrs: DocumentAttributes): void {
	if (attrs.textAlign !== undefined && !['start', 'center', 'end', 'justify'].includes(String(attrs.textAlign))) {
		throw new TypeError('Paragraph alignment must be start, center, end, or justify');
	}
	for (const [key, min, max] of [['lineSpacing', 1, 3], ['spaceBefore', 0, 144], ['spaceAfter', 0, 144]] as const) {
		const value = attrs[key];
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) {
			throw new RangeError(`Paragraph ${key} must be a number between ${min} and ${max}`);
		}
	}
}
