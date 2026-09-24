import { Emitter, type Event } from "../../../../base/common/event.js";
import { createUuid } from "../../../../base/common/uuid.js";
import { emptyPdfAnnotationDocument, parsePdfAnnotationDocument, serializePdfAnnotationDocument, type PdfAnnotation, type PdfAnnotationDocument, type PdfAnnotationPoint, type PdfAnnotationRect, type PdfHighlightAnnotation, type PdfInkAnnotation, type PdfNoteAnnotation } from "../common/pdfAnnotations.js";
import type { PdfAnnotationSnapshot } from "./pdfAnnotationStore.js";

export type PdfAnnotationColor = string;

/** Browser-owned mutation model for one PDF annotation sidecar. */
export class PdfAnnotationModel {
	private readonly changeEmitter = new Emitter<void>();
	private document = emptyPdfAnnotationDocument();
	private saved = serializePdfAnnotationDocument(this.document);
	private undoStack: PdfAnnotationDocument[] = [];
	private redoStack: PdfAnnotationDocument[] = [];
	private _revision: string | undefined;

	readonly onDidChange: Event<void> = this.changeEmitter.event;

	get annotations(): readonly PdfAnnotation[] {
		return this.document.annotations;
	}

	/** Returns an immutable snapshot suitable for durable sidecar persistence. */
	get snapshot(): PdfAnnotationDocument {
		return this.document;
	}

	get isDirty(): boolean {
		return serializePdfAnnotationDocument(this.document) !== this.saved;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	get revision(): string | undefined {
		return this._revision;
	}

	restore(snapshot: PdfAnnotationSnapshot): void {
		this.document = clone(snapshot.document);
		this.saved = serializePdfAnnotationDocument(this.document);
		this._revision = snapshot.revision;
		this.undoStack = [];
		this.redoStack = [];
		this.changeEmitter.fire();
	}

	addHighlight(page: number, rect: PdfAnnotationRect, color: PdfAnnotationColor, now = new Date()): PdfAnnotation {
		return this.add({ kind: "highlight", page, rect, color }, now);
	}

	addInk(page: number, points: readonly PdfAnnotationPoint[], color: PdfAnnotationColor, now = new Date()): PdfAnnotation {
		return this.add({ kind: "ink", page, points, color }, now);
	}

	addNote(page: number, point: PdfAnnotationPoint, text: string, color: PdfAnnotationColor, now = new Date()): PdfAnnotation {
		return this.add({ kind: "note", page, point, text, color }, now);
	}

	updateNote(id: string, text: string, now = new Date()): void {
		const annotation = this.document.annotations.find((candidate) => candidate.id === id);
		if (!annotation || annotation.kind !== "note") return;
		this.apply({ version: this.document.version, annotations: this.document.annotations.map((candidate) => candidate.id === id ? { ...candidate, text, updatedAt: now.toISOString() } : candidate) });
	}

	remove(id: string): void {
		if (!this.document.annotations.some((annotation) => annotation.id === id)) return;
		this.apply({ version: this.document.version, annotations: this.document.annotations.filter((annotation) => annotation.id !== id) });
	}

	undo(): void {
		const previous = this.undoStack.pop();
		if (!previous) return;
		this.redoStack.push(this.document);
		this.document = previous;
		this.changeEmitter.fire();
	}

	redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.document);
		this.document = next;
		this.changeEmitter.fire();
	}

	markSaved(snapshot: PdfAnnotationSnapshot): void {
		this.document = clone(snapshot.document);
		this.saved = serializePdfAnnotationDocument(this.document);
		this._revision = snapshot.revision;
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	private add(annotation: NewPdfAnnotation, now: Date): PdfAnnotation {
		const timestamp = now.toISOString();
		const created = { ...annotation, id: createUuid(), createdAt: timestamp, updatedAt: timestamp } as PdfAnnotation;
		this.apply({ version: this.document.version, annotations: [...this.document.annotations, created] });
		return created;
	}

	private apply(next: PdfAnnotationDocument): void {
		const serialized = serializePdfAnnotationDocument(next);
		if (serialized === serializePdfAnnotationDocument(this.document)) return;
		this.undoStack.push(this.document);
		this.redoStack = [];
		this.document = parsePdfAnnotationDocument(serialized);
		this.changeEmitter.fire();
	}
}

type NewPdfAnnotation =
	| Omit<PdfHighlightAnnotation, "id" | "createdAt" | "updatedAt">
	| Omit<PdfInkAnnotation, "id" | "createdAt" | "updatedAt">
	| Omit<PdfNoteAnnotation, "id" | "createdAt" | "updatedAt">;

function clone(document: PdfAnnotationDocument): PdfAnnotationDocument {
	return parsePdfAnnotationDocument(serializePdfAnnotationDocument(document));
}
