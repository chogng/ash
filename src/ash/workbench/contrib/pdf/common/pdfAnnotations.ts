export const PDF_ANNOTATION_DOCUMENT_VERSION = 1;

export type PdfAnnotationKind = "highlight" | "ink" | "note";

/** A point stored in page-relative coordinates, independent of zoom and DPI. */
export interface PdfAnnotationPoint {
	readonly x: number;
	readonly y: number;
}

/** A page-relative rectangle used by highlight annotations. */
export interface PdfAnnotationRect extends PdfAnnotationPoint {
	readonly width: number;
	readonly height: number;
}

interface PdfAnnotationBase {
	readonly id: string;
	readonly kind: PdfAnnotationKind;
	readonly page: number;
	readonly color: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** A translucent rectangular markup anchored to one rendered PDF page. */
export interface PdfHighlightAnnotation extends PdfAnnotationBase {
	readonly kind: "highlight";
	readonly rect: PdfAnnotationRect;
}

/** A freehand stroke anchored to one rendered PDF page. */
export interface PdfInkAnnotation extends PdfAnnotationBase {
	readonly kind: "ink";
	readonly points: readonly PdfAnnotationPoint[];
}

/** A text comment anchored to one point on a rendered PDF page. */
export interface PdfNoteAnnotation extends PdfAnnotationBase {
	readonly kind: "note";
	readonly point: PdfAnnotationPoint;
	readonly text: string;
}

export type PdfAnnotation = PdfHighlightAnnotation | PdfInkAnnotation | PdfNoteAnnotation;

/** Durable companion data stored beside a PDF without rewriting its bytes. */
export interface PdfAnnotationDocument {
	readonly version: typeof PDF_ANNOTATION_DOCUMENT_VERSION;
	readonly annotations: readonly PdfAnnotation[];
}

/** Returns a valid empty annotation document. */
export function emptyPdfAnnotationDocument(): PdfAnnotationDocument {
	return Object.freeze({ version: PDF_ANNOTATION_DOCUMENT_VERSION, annotations: Object.freeze([]) });
}

/** Parses and validates the complete durable annotation sidecar format. */
export function parsePdfAnnotationDocument(source: string): PdfAnnotationDocument {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new SyntaxError("PDF annotation document is not valid JSON", { cause: error });
	}
	const document = record(value, "PDF annotation document");
	requireExactKeys(document, ["version", "annotations"], "PDF annotation document");
	if (document.version !== PDF_ANNOTATION_DOCUMENT_VERSION) {
		throw new RangeError(`Unsupported PDF annotation document version: ${String(document.version)}`);
	}
	if (!Array.isArray(document.annotations)) throw new TypeError("PDF annotation document annotations must be an array");
	const ids = new Set<string>();
	const annotations = document.annotations.map((annotation, index) => {
		const decoded = parseAnnotation(annotation, `PDF annotation document annotations[${index}]`);
		if (ids.has(decoded.id)) throw new RangeError(`PDF annotation document contains duplicate annotation ID: ${decoded.id}`);
		ids.add(decoded.id);
		return decoded;
	});
	return Object.freeze({ version: PDF_ANNOTATION_DOCUMENT_VERSION, annotations: Object.freeze(annotations) });
}

/** Serializes annotation data deterministically for sidecar persistence and revision checks. */
export function serializePdfAnnotationDocument(document: PdfAnnotationDocument): string {
	const validated = parsePdfAnnotationDocument(JSON.stringify(document));
	return `${JSON.stringify(validated, undefined, 2)}\n`;
}

function parseAnnotation(value: unknown, path: string): PdfAnnotation {
	const annotation = record(value, path);
	const kind = string(annotation.kind, `${path}.kind`);
	const base = {
		id: identifier(annotation.id, `${path}.id`),
		page: positiveInteger(annotation.page, `${path}.page`),
		color: color(annotation.color, `${path}.color`),
		createdAt: timestamp(annotation.createdAt, `${path}.createdAt`),
		updatedAt: timestamp(annotation.updatedAt, `${path}.updatedAt`),
	};
	switch (kind) {
		case "highlight":
			requireExactKeys(annotation, ["id", "kind", "page", "color", "createdAt", "updatedAt", "rect"], path);
			return Object.freeze({ ...base, kind, rect: rect(annotation.rect, `${path}.rect`) });
		case "ink": {
			requireExactKeys(annotation, ["id", "kind", "page", "color", "createdAt", "updatedAt", "points"], path);
			if (!Array.isArray(annotation.points) || annotation.points.length < 2 || annotation.points.length > 8192) {
				throw new RangeError(`${path}.points must contain between 2 and 8192 points`);
			}
			return Object.freeze({ ...base, kind, points: Object.freeze(annotation.points.map((point, index) => pointValue(point, `${path}.points[${index}]`))) });
		}
		case "note":
			requireExactKeys(annotation, ["id", "kind", "page", "color", "createdAt", "updatedAt", "point", "text"], path);
			return Object.freeze({ ...base, kind, point: pointValue(annotation.point, `${path}.point`), text: text(annotation.text, `${path}.text`) });
		default:
			throw new RangeError(`${path}.kind is not supported: ${kind}`);
	}
}

function pointValue(value: unknown, path: string): PdfAnnotationPoint {
	const point = record(value, path);
	requireExactKeys(point, ["x", "y"], path);
	return Object.freeze({ x: relative(point.x, `${path}.x`), y: relative(point.y, `${path}.y`) });
}

function rect(value: unknown, path: string): PdfAnnotationRect {
	const result = record(value, path);
	requireExactKeys(result, ["x", "y", "width", "height"], path);
	const x = relative(result.x, `${path}.x`);
	const y = relative(result.y, `${path}.y`);
	const width = positiveRelative(result.width, `${path}.width`);
	const height = positiveRelative(result.height, `${path}.height`);
	if (x + width > 1 || y + height > 1) throw new RangeError(`${path} must remain inside its page bounds`);
	return Object.freeze({ x, y, width, height });
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new TypeError(`${path} has unexpected keys`);
	}
}

function identifier(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new TypeError(`${path} must be a stable annotation ID`);
	return value;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
	return value;
}

function color(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new TypeError(`${path} must be a six-digit hexadecimal color`);
	return value.toLowerCase();
}

function timestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${path} must be an ISO timestamp`);
	return value;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length > 10_000) throw new RangeError(`${path} must be text no longer than 10000 characters`);
	return value;
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RangeError(`${path} must be a positive integer`);
	return value as number;
}

function relative(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${path} must be between 0 and 1`);
	return value;
}

function positiveRelative(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError(`${path} must be greater than 0 and no more than 1`);
	return value;
}
