import type { ArtifactCanvasTextMeasurer } from './artifactCanvasText.js';
import { ArtifactWorkspaceId } from '../artifactWorkspace.js';
import { Emitter } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { documentFromShapes, serializeArtifactCanvasDocument, type ArtifactCanvasAsset, type ArtifactCanvasDocument, type ArtifactCanvasShape } from './artifactCanvasDocument.js';
import { recordArtifactCanvasOverrides, resolveArtifactCanvasComponents } from './components.js';
import { emptyArtifactCanvasResources, getArtifactCanvasLibraryShapes, recordArtifactCanvasResourceEdits, resolveArtifactCanvasResources, type ArtifactCanvasResources } from './artifactCanvasResources.js';
import { reconcilePrototypeLinks } from './prototype.js';
import { resolveArtifactCanvasLayout } from './layout.js';

/** Owns committed edits. A pointer gesture commits once, so undo restores the whole gesture. */
export class ArtifactCanvasModel extends Disposable {
	private document: ArtifactCanvasDocument;
	constructor(mode: ArtifactWorkspaceId = ArtifactWorkspaceId.Design, public readonly measureText?: ArtifactCanvasTextMeasurer) {
		super();
		this.document = documentFromShapes([], { documentId: generateUuid(), artifactId: generateUuid(), mode, createdAt: Date.now() });
	}
	private modelEpoch = generateUuid();
	private editRevision = 0;
	private undoGroup: object | undefined;
	private readonly undoStack: ArtifactCanvasDocument[] = [];
	private readonly redoStack: ArtifactCanvasDocument[] = [];
	private readonly changeEmitter = this._register(new Emitter<'edit' | 'replace'>());
	/** Replacement resets per-view selection; edits retain surviving object IDs. */
	public readonly onDidChange = this.changeEmitter.event;

	public get value(): ArtifactCanvasDocument { return this.document; }
	public get version(): string { return `${this.document.documentId}:${this.modelEpoch}:${this.editRevision}`; }
	public get canUndo(): boolean { return this.undoStack.length > 0; }
	public get canRedo(): boolean { return this.redoStack.length > 0; }

	/** Save As changes identity across history so undo cannot return to the source document. */
	public changeIdentity(documentId: string): void {
		const change = (document: ArtifactCanvasDocument): ArtifactCanvasDocument => documentFromShapes(document.shapes, { ...document, documentId }, document.assets);
		this.document = change(this.document);
		for (let index = 0; index < this.undoStack.length; index++) { this.undoStack[index] = change(this.undoStack[index]); }
		for (let index = 0; index < this.redoStack.length; index++) { this.redoStack[index] = change(this.redoStack[index]); }
		this.modelEpoch = generateUuid();
		this.editRevision = 0;
		this.changeEmitter.fire('edit');
	}

	public replace(document: ArtifactCanvasDocument): void {
		this.undoGroup = undefined;
		// Files retain materialized instances for orphan recovery. A surviving main
		// still owns inherited fields when loading an externally edited document.
		const resources = document.resources ?? emptyArtifactCanvasResources;
		const source = resolveArtifactCanvasResources(document.shapes, resources);
		const components = resolveArtifactCanvasComponents(source, resolveArtifactCanvasResources(getArtifactCanvasLibraryShapes(resources), resources), this.measureText);
		const resolved = resolveArtifactCanvasResources(components, resources);
		this.document = documentFromShapes(resolveArtifactCanvasLayout(resolved, resolved, this.measureText), document, document.assets);
		this.modelEpoch = generateUuid();
		this.editRevision = 0;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.changeEmitter.fire('replace');
	}

	/** Font availability changes derived geometry in every history entry, never adds an edit. */
	public refreshTextLayout(): void {
		const refresh = (document: ArtifactCanvasDocument): ArtifactCanvasDocument => documentFromShapes(resolveArtifactCanvasLayout(document.shapes, document.shapes, this.measureText), document, document.assets);
		this.document = refresh(this.document);
		for (let index = 0; index < this.undoStack.length; index++) { this.undoStack[index] = refresh(this.undoStack[index]); }
		for (let index = 0; index < this.redoStack.length; index++) { this.redoStack[index] = refresh(this.redoStack[index]); }
		this.editRevision++; this.changeEmitter.fire('edit');
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

	public applyEdit(shapes: readonly ArtifactCanvasShape[], assets: readonly ArtifactCanvasAsset[] = this.document.assets, resources: ArtifactCanvasResources | undefined = this.document.resources, undoGroup?: object): void {
		const edits = recordArtifactCanvasResourceEdits(shapes, this.document.shapes);
		const source = resolveArtifactCanvasResources(recordArtifactCanvasOverrides(edits, this.document.shapes), resources);
		const layout = resolveArtifactCanvasLayout(source, this.document.shapes, this.measureText);
		const components = resolveArtifactCanvasResources(resolveArtifactCanvasComponents(layout, resolveArtifactCanvasResources(getArtifactCanvasLibraryShapes(resources), resources), this.measureText), resources);
		// Removing a wire target is derived cleanup, not an explicit instance override.
		const resolved = reconcilePrototypeLinks(resolveArtifactCanvasLayout(components, components, this.measureText), this.document.shapes);
		const { documentId, artifactId, mode, background, title, createdAt } = this.document;
		const next = documentFromShapes(resolved, {
			documentId, artifactId, mode,
			...(createdAt === undefined ? {} : { createdAt }),
			...(background === undefined ? {} : { background }),
			...(title === undefined ? {} : { title }),
			...(resources ? { resources } : {}),
		}, assets);
		this.commit(next, undoGroup);
	}

	public setBackground(background: string): void {
		this.commit(documentFromShapes(this.document.shapes, { ...this.document, background }, this.document.assets));
	}

	public setTitle(title: string): void {
		this.commit(documentFromShapes(this.document.shapes, { ...this.document, title }, this.document.assets));
	}

	private commit(next: ArtifactCanvasDocument, undoGroup?: object): void {
		if (serializeArtifactCanvasDocument(next) === serializeArtifactCanvasDocument(this.document)) {
			return;
		}
		if (!undoGroup || undoGroup !== this.undoGroup) { this.undoStack.push(this.document); }
		this.undoGroup = undoGroup;
		this.redoStack.length = 0;
		this.document = next;
		this.editRevision++;
		this.changeEmitter.fire('edit');
	}
}
