import type { DesignTextMeasurer } from './designText.js';
import { CreatorMode } from '../creator.js';
import { Emitter } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { documentFromShapes, serializeDesignDocument, type DesignAsset, type DesignDocument, type DesignShape } from './document.js';
import { recordDesignOverrides, resolveDesignComponents } from './components.js';
import { emptyDesignResources, getDesignLibraryShapes, recordDesignResourceEdits, resolveDesignResources, type DesignResources } from './designResources.js';
import { reconcilePrototypeLinks } from './prototype.js';
import { resolveDesignLayout } from './layout.js';

/** Owns committed edits. A pointer gesture commits once, so undo restores the whole gesture. */
export class DesignModel extends Disposable {
	private document: DesignDocument;
	constructor(
		mode: CreatorMode = CreatorMode.Design,
		public readonly measureText?: DesignTextMeasurer,
	) {
		super();
		this.document = documentFromShapes([], { documentId: generateUuid(), artifactId: generateUuid(), mode });
	}
	private modelEpoch = generateUuid();
	private editRevision = 0;
	private undoGroup: object | undefined;
	private readonly undoStack: DesignDocument[] = [];
	private readonly redoStack: DesignDocument[] = [];
	private readonly changeEmitter = this._register(new Emitter<'edit' | 'replace'>());
	/** Replacement resets per-view selection; edits retain surviving object IDs. */
	public readonly onDidChange = this.changeEmitter.event;

	public get value(): DesignDocument {
		return this.document;
	}
	public get version(): string {
		return `${this.document.documentId}:${this.modelEpoch}:${this.editRevision}`;
	}
	public get canUndo(): boolean {
		return this.undoStack.length > 0;
	}
	public get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** Save As changes identity across history so undo cannot return to the source document. */
	public changeIdentity(documentId: string): void {
		const change = (document: DesignDocument): DesignDocument => documentFromShapes(document.shapes, { ...document, documentId }, document.assets);
		this.document = change(this.document);
		for (let index = 0; index < this.undoStack.length; index++) {
			this.undoStack[index] = change(this.undoStack[index]);
		}
		for (let index = 0; index < this.redoStack.length; index++) {
			this.redoStack[index] = change(this.redoStack[index]);
		}
		this.modelEpoch = generateUuid();
		this.editRevision = 0;
		this.changeEmitter.fire('edit');
	}

	public replace(document: DesignDocument): void {
		this.undoGroup = undefined;
		// Files retain materialized instances for orphan recovery. A surviving main
		// still owns inherited fields when loading an externally edited document.
		const resources = document.resources ?? emptyDesignResources;
		const source = resolveDesignResources(document.shapes, resources);
		const components = resolveDesignComponents(source, resolveDesignResources(getDesignLibraryShapes(resources), resources), this.measureText);
		const resolved = resolveDesignResources(components, resources);
		this.document = documentFromShapes(resolveDesignLayout(resolved, resolved, this.measureText), document, document.assets);
		this.modelEpoch = generateUuid();
		this.editRevision = 0;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.changeEmitter.fire('replace');
	}

	/** Font availability changes derived geometry in every history entry, never adds an edit. */
	public refreshTextLayout(): void {
		const refresh = (document: DesignDocument): DesignDocument => documentFromShapes(resolveDesignLayout(document.shapes, document.shapes, this.measureText), document, document.assets);
		this.document = refresh(this.document);
		for (let index = 0; index < this.undoStack.length; index++) {
			this.undoStack[index] = refresh(this.undoStack[index]);
		}
		for (let index = 0; index < this.redoStack.length; index++) {
			this.redoStack[index] = refresh(this.redoStack[index]);
		}
		this.editRevision++;
		this.changeEmitter.fire('edit');
	}

	public undo(): void {
		this.undoGroup = undefined;
		const previous = this.undoStack.pop();
		if (previous) {
			this.redoStack.push(this.document);
			this.document = previous;
			this.editRevision++;
			this.changeEmitter.fire('edit');
		}
	}

	public redo(): void {
		this.undoGroup = undefined;
		const next = this.redoStack.pop();
		if (next) {
			this.undoStack.push(this.document);
			this.document = next;
			this.editRevision++;
			this.changeEmitter.fire('edit');
		}
	}

	public applyEdit(
		shapes: readonly DesignShape[],
		assets: readonly DesignAsset[] = this.document.assets,
		resources: DesignResources | undefined = this.document.resources,
		undoGroup?: object,
	): void {
		const edits = recordDesignResourceEdits(shapes, this.document.shapes);
		const source = resolveDesignResources(recordDesignOverrides(edits, this.document.shapes), resources);
		const layout = resolveDesignLayout(source, this.document.shapes, this.measureText);
		const components = resolveDesignResources(resolveDesignComponents(layout, resolveDesignResources(getDesignLibraryShapes(resources), resources), this.measureText), resources);
		// Removing a wire target is derived cleanup, not an explicit instance override.
		const resolved = reconcilePrototypeLinks(resolveDesignLayout(components, components, this.measureText), this.document.shapes);
		const next = documentFromShapes(
			resolved,
			{
				documentId: this.document.documentId,
				artifactId: this.document.artifactId,
				mode: this.document.mode,
				...(this.document.background === undefined ? {} : { background: this.document.background }),
				...(resources ? { resources } : {}),
			},
			assets,
		);
		this.commit(next, undoGroup);
	}

	public setBackground(background: string): void {
		this.commit(documentFromShapes(this.document.shapes, { ...this.document, background }, this.document.assets));
	}

	private commit(next: DesignDocument, undoGroup?: object): void {
		if (serializeDesignDocument(next) === serializeDesignDocument(this.document)) {
			return;
		}
		if (!undoGroup || undoGroup !== this.undoGroup) {
			this.undoStack.push(this.document);
		}
		this.undoGroup = undoGroup;
		this.redoStack.length = 0;
		this.document = next;
		this.editRevision++;
		this.changeEmitter.fire('edit');
	}
}
