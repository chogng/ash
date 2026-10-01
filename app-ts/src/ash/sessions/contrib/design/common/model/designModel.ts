import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { documentFromShapes, serializeDesignDocument, type DesignDocument, type DesignShape } from './document.js';

/** Owns committed edits. A pointer gesture commits once, so undo restores the whole gesture. */
export class DesignModel extends Disposable {
	private document = documentFromShapes([]);
	private readonly undoStack: DesignDocument[] = [];
	private readonly redoStack: DesignDocument[] = [];
	private readonly changeEmitter = this._register(new Emitter<'edit' | 'replace'>());
	/** Replacement resets per-view selection; edits retain surviving object IDs. */
	public readonly onDidChange = this.changeEmitter.event;

	public get value(): DesignDocument { return this.document; }
	public get canUndo(): boolean { return this.undoStack.length > 0; }
	public get canRedo(): boolean { return this.redoStack.length > 0; }

	public replace(document: DesignDocument): void {
		this.document = document;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.changeEmitter.fire('replace');
	}

	public undo(): void {
		const previous = this.undoStack.pop();
		if (previous) {
			this.redoStack.push(this.document);
			this.document = previous;
			this.changeEmitter.fire('edit');
		}
	}

	public redo(): void {
		const next = this.redoStack.pop();
		if (next) {
			this.undoStack.push(this.document);
			this.document = next;
			this.changeEmitter.fire('edit');
		}
	}

	public applyEdit(shapes: readonly DesignShape[]): void {
		const next = documentFromShapes(shapes);
		if (serializeDesignDocument(next) === serializeDesignDocument(this.document)) {
			return;
		}
		this.undoStack.push(this.document);
		this.redoStack.length = 0;
		this.document = next;
		this.changeEmitter.fire('edit');
	}
}
