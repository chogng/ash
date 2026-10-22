import { applyDocumentTransaction, type DocumentTransaction } from "./documentTransaction.js";
import type { DocumentAttributes, DocumentNode } from "./document.js";
import { textSelection, type DocumentPoint, type DocumentSelection } from "../core/documentSelection.js";
import type { DocumentSchema } from "./documentSchema.js";

export interface DocumentDecorationOptions {
	readonly id: string;
	readonly from: DocumentPoint;
	readonly to?: DocumentPoint;
	readonly className?: string;
	readonly attrs?: DocumentAttributes;
}

/** A DOM-free annotation over an identity-based text range. */
export interface DocumentDecoration {
	readonly id: string;
	readonly from: DocumentPoint;
	readonly to: DocumentPoint;
	readonly className: string | undefined;
	readonly attrs: DocumentAttributes;
}

/** Creates an immutable decoration that can be projected by any Stanza view. */
export function createDocumentDecoration(options: DocumentDecorationOptions): DocumentDecoration {
	if (typeof options.id !== "string" || options.id.trim().length === 0) throw new TypeError("Document decorations require a non-empty id");
	if (options.className !== undefined && typeof options.className !== "string") throw new TypeError("Document decoration className must be a string");
	return Object.freeze({
		id: options.id,
		from: Object.freeze({ ...options.from }),
		to: Object.freeze({ ...(options.to ?? options.from) }),
		className: options.className,
		attrs: Object.freeze({ ...(options.attrs ?? {}) }),
	});
}

/** Immutable collection of decorations with transaction-aware range mapping. */
export class DocumentDecorationSet {
	readonly decorations: readonly DocumentDecoration[];
	private readonly byId: ReadonlyMap<string, DocumentDecoration>;

	constructor(decorations: readonly DocumentDecoration[] = []) {
		const byId = new Map<string, DocumentDecoration>();
		const normalized: DocumentDecoration[] = [];
		for (const decoration of decorations) {
			const value = createDocumentDecoration(decoration);
			if (byId.has(value.id)) throw new Error(`Duplicate document decoration id '${value.id}'`);
			byId.set(value.id, value);
			normalized.push(value);
		}
		this.decorations = Object.freeze(normalized);
		this.byId = byId;
		Object.freeze(this);
	}

	get size(): number {
		return this.decorations.length;
	}

	get(id: string): DocumentDecoration | undefined {
		return this.byId.get(id);
	}

	add(decoration: DocumentDecoration): DocumentDecorationSet {
		const value = createDocumentDecoration(decoration);
		if (this.byId.has(value.id)) throw new Error(`Duplicate document decoration id '${value.id}'`);
		return new DocumentDecorationSet([...this.decorations, value]);
	}

	remove(ids: readonly string[]): DocumentDecorationSet {
		if (ids.length === 0) return this;
		const removed = new Set(ids);
		const next = this.decorations.filter(decoration => !removed.has(decoration.id));
		return next.length === this.decorations.length ? this : new DocumentDecorationSet(next);
	}

	/** Maps all ranges through one transaction and drops ranges with no surviving text endpoint. */
	map(document: DocumentNode, schema: DocumentSchema, transaction: DocumentTransaction): DocumentDecorationSet {
		const applied = applyDocumentTransaction(document, schema, transaction);
		const mapped: DocumentDecoration[] = [];
		for (const decoration of this.decorations) {
			const selection = applied.mapping.mapSelection(textSelectionForDecoration(decoration));
			if (!selection || selection.kind !== "text") continue;
			mapped.push(createDocumentDecoration({ id: decoration.id, from: selection.anchor, to: selection.head, className: decoration.className, attrs: decoration.attrs }));
		}
		return new DocumentDecorationSet(mapped);
	}
}

function textSelectionForDecoration(decoration: DocumentDecoration): DocumentSelection {
	return textSelection(decoration.from, decoration.to);
}
