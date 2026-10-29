import { validateDocumentPaginationAttributes } from './documentPageLayout.js';
import type { DocumentAttributes, DocumentNode } from './document.js';

/** Persistent paragraph measurements use points, independent of viewport zoom and UI spacing tokens. */
export interface DocumentParagraphAttributes {
	readonly pageBreakBefore?: boolean;
	readonly keepWithNext?: boolean;
	readonly keepTogether?: boolean;
	readonly widowControl?: boolean;
	readonly textAlign?: 'start' | 'center' | 'end' | 'justify';
	readonly lineSpacing?: number;
	readonly spaceBefore?: number;
	readonly spaceAfter?: number;
	readonly indentStart?: number;
	readonly indentEnd?: number;
	/** Negative values represent a hanging indent. */
	readonly firstLineIndent?: number;
	readonly fontFamily?: 'sans' | 'serif' | 'monospace';
	/** CSS pixels, matching existing character textStyle marks. */
	readonly fontSize?: number;
}

/** Existing continuous-document defaults; absent attributes keep old documents visually compatible. */
export const defaultDocumentParagraphAttributes: Required<Omit<DocumentParagraphAttributes, 'fontFamily' | 'fontSize'>> = Object.freeze({
	pageBreakBefore: false, keepWithNext: false, keepTogether: false, widowControl: true,
	textAlign: 'start', lineSpacing: 1.6, spaceBefore: 0, spaceAfter: 9, indentStart: 0, indentEnd: 0, firstLineIndent: 0,
});

/** Schema validation covers files, clipboard fragments, remote transactions and local commands alike. */
export function validateDocumentParagraphAttributes(attrs: DocumentAttributes): void {
	validateDocumentPaginationAttributes(attrs);
	if (attrs.textAlign !== undefined && !['start', 'center', 'end', 'justify'].includes(String(attrs.textAlign))) {
		throw new TypeError('Paragraph alignment must be start, center, end, or justify');
	}
	if (attrs.styleId !== undefined && (typeof attrs.styleId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(attrs.styleId))) throw new TypeError('Invalid paragraph style reference');
	if (attrs.fontFamily !== undefined && !['sans', 'serif', 'monospace'].includes(String(attrs.fontFamily))) throw new TypeError('Invalid paragraph font family');
	for (const [key, min, max] of [
		['lineSpacing', 1, 3], ['spaceBefore', 0, 144], ['spaceAfter', 0, 144],
		['indentStart', 0, 720], ['indentEnd', 0, 720], ['firstLineIndent', -144, 144], ['fontSize', 8, 72],
	] as const) {
		const value = attrs[key];
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) {
			throw new RangeError(`Paragraph ${key} must be a number between ${min} and ${max}`);
		}
	}
}

/** Definitions are document data, never a process-global registry or a second model. */
export interface DocumentParagraphStyle {
	readonly id: string;
	readonly name: string;
	readonly level: number;
	readonly attrs: DocumentParagraphAttributes;
}

export const documentParagraphFormatKeys = ['pageBreakBefore', 'keepWithNext', 'keepTogether', 'widowControl', 'textAlign', 'lineSpacing', 'spaceBefore', 'spaceAfter', 'indentStart', 'indentEnd', 'firstLineIndent', 'fontFamily', 'fontSize'] as const;

/** The scalar JSON attribute keeps the existing document/transaction wire format compatible. */
export function getDocumentParagraphStyles(document: DocumentNode): readonly DocumentParagraphStyle[] {
	return document.attrs.paragraphStyles === undefined ? [] : JSON.parse(String(document.attrs.paragraphStyles));
}

export function resolveDocumentParagraphAttributes(document: DocumentNode, paragraph: DocumentNode): DocumentAttributes {
	const style = getDocumentParagraphStyles(document).find(style => style.id === paragraph.attrs.styleId);
	return { ...defaultDocumentParagraphAttributes, ...style?.attrs, ...paragraph.attrs };
}

/** Called at the schema boundary for files, clipboard data and remote transactions. */
export function validateDocumentParagraphStyles(document: DocumentNode): void {
	const encoded = document.attrs.paragraphStyles;
	if (encoded !== undefined && (typeof encoded !== 'string' || encoded.length > 100_000)) throw new TypeError('Invalid paragraph style definitions');
	const styles: unknown = getDocumentParagraphStyles(document);
	if (!Array.isArray(styles) || styles.length > 100) throw new TypeError('At most 100 paragraph styles are supported');
	const ids = new Set<string>();
	for (const style of styles) {
		if (!style || typeof style !== 'object' || typeof style.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(style.id) || ids.has(style.id)) throw new TypeError('Invalid or duplicate paragraph style identity');
		if (typeof style.name !== 'string' || !style.name.trim() || style.name.length > 80) throw new TypeError('Invalid paragraph style name');
		if (!Number.isInteger(style.level) || style.level < 0 || style.level > 6) throw new TypeError('Invalid paragraph style heading level');
		if (!style.attrs || typeof style.attrs !== 'object' || Array.isArray(style.attrs) || Object.keys(style.attrs).some(key => !documentParagraphFormatKeys.includes(key as typeof documentParagraphFormatKeys[number]))) throw new TypeError('Invalid paragraph style formatting');
		validateDocumentParagraphAttributes(style.attrs);
		ids.add(style.id);
	}
	const visit = (node: DocumentNode): void => {
		if (node.type === 'paragraph' || node.type === 'heading') {
			const id = node.attrs.styleId;
			if (id !== undefined) {
				const style = styles.find(style => style.id === id);
				if (!style || (style.level === 0 ? node.type !== 'paragraph' : node.type !== 'heading' || node.attrs.level !== style.level)) throw new TypeError('Paragraph style reference does not match its definition');
			}
		}
		for (const child of node.content) visit(child);
	};
	visit(document);
}
