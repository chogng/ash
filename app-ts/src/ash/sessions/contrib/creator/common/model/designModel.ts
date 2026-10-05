import { CreatorMode } from '../creator.js';
import { Emitter } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { documentFromShapes, serializeDesignDocument, type DesignAsset, type DesignDocument, type DesignShape } from './document.js';

/** Owns committed edits. A pointer gesture commits once, so undo restores the whole gesture. */
export class DesignModel extends Disposable {
	private document: DesignDocument;
	constructor(mode: CreatorMode = CreatorMode.Design) {
		super();
		this.document = documentFromShapes([], { documentId: generateUuid(), artifactId: generateUuid(), mode });
	}
	private modelEpoch = generateUuid();
	private editRevision = 0;
	private readonly undoStack: DesignDocument[] = [];
	private readonly redoStack: DesignDocument[] = [];
	private readonly changeEmitter = this._register(new Emitter<'edit' | 'replace'>());
	/** Replacement resets per-view selection; edits retain surviving object IDs. */
	public readonly onDidChange = this.changeEmitter.event;

	public get value(): DesignDocument { return this.document; }
	public get version(): string { return `${this.document.documentId}:${this.modelEpoch}:${this.editRevision}`; }
	public get canUndo(): boolean { return this.undoStack.length > 0; }
	public get canRedo(): boolean { return this.redoStack.length > 0; }

	/** Save As changes identity across history so undo cannot return to the source document. */
	public changeIdentity(documentId: string): void {
		const change = (document: DesignDocument): DesignDocument => documentFromShapes(document.shapes, { documentId, artifactId: document.artifactId, mode: document.mode }, document.assets);
		this.document = change(this.document);
		for (let index = 0; index < this.undoStack.length; index++) { this.undoStack[index] = change(this.undoStack[index]); }
		for (let index = 0; index < this.redoStack.length; index++) { this.redoStack[index] = change(this.redoStack[index]); }
		this.modelEpoch = generateUuid();
		this.editRevision = 0;
		this.changeEmitter.fire('edit');
	}

	public replace(document: DesignDocument): void {
		this.document = document;
		this.modelEpoch = generateUuid();
		this.editRevision = 0;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.changeEmitter.fire('replace');
	}

	public undo(): void {
		const previous = this.undoStack.pop();
		if (previous) {
			this.redoStack.push(this.document);
			this.document = previous;
			this.editRevision++;
			this.changeEmitter.fire('edit');
		}
	}

	public redo(): void {
		const next = this.redoStack.pop();
		if (next) {
			this.undoStack.push(this.document);
			this.document = next;
			this.editRevision++;
			this.changeEmitter.fire('edit');
		}
	}

	public applyEdit(shapes: readonly DesignShape[], assets: readonly DesignAsset[] = this.document.assets): void {
		const next = documentFromShapes(shapes, { documentId: this.document.documentId, artifactId: this.document.artifactId, mode: this.document.mode }, assets);
		if (serializeDesignDocument(next) === serializeDesignDocument(this.document)) {
			return;
		}
		this.undoStack.push(this.document);
		this.redoStack.length = 0;
		this.document = next;
		this.editRevision++;
		this.changeEmitter.fire('edit');
	}
}
