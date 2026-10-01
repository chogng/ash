import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../base/common/uuid.js';

export interface DesignPoint {
	readonly x: number;
	readonly y: number;
}

/** Geometry is in design pixels, independent of zoom and the display's pixel ratio. */
export interface DesignShape extends DesignPoint {
	readonly id: string;
	readonly kind: 'rectangle' | 'ellipse';
	readonly width: number;
	readonly height: number;
	/** Clockwise degrees around the shape's center. */
	readonly rotation: number;
	readonly fill: string;
}

export interface DesignDocument {
	readonly version: 1;
	/** Array order is paint order, from back to front. */
	readonly shapes: readonly DesignShape[];
}

function documentFromShapes(shapes: readonly DesignShape[]): DesignDocument {
	return Object.freeze({ version: 1, shapes: Object.freeze(shapes.map(shape => Object.freeze({ ...shape }))) });
}

/** Rejects the complete file before any active document state changes. */
export function parseDesignDocument(content: string): DesignDocument {
	const value: unknown = JSON.parse(content);
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.shapes) || Object.keys(value).some(key => key !== 'version' && key !== 'shapes')) {
		throw new TypeError('Invalid design document');
	}
	const ids = new Set<string>();
	const shapes: DesignShape[] = [];
	for (const shape of value.shapes) {
		if (!isRecord(shape) || !isUuid(shape.id) || ids.has(shape.id)
			|| (shape.kind !== 'rectangle' && shape.kind !== 'ellipse')
			|| !['x', 'y', 'width', 'height', 'rotation'].every(key => typeof shape[key] === 'number' && Number.isFinite(shape[key]))
			|| (shape.width as number) <= 0 || (shape.height as number) <= 0
			|| typeof shape.fill !== 'string' || !/^#[0-9a-f]{6}$/iu.test(shape.fill)
			|| Object.keys(shape).some(key => !['id', 'kind', 'x', 'y', 'width', 'height', 'rotation', 'fill'].includes(key))) {
			throw new TypeError('Invalid design shape');
		}
		ids.add(shape.id);
		shapes.push({ id: shape.id, kind: shape.kind, x: shape.x as number, y: shape.y as number, width: shape.width as number, height: shape.height as number, rotation: shape.rotation as number, fill: shape.fill });
	}
	return documentFromShapes(shapes);
}

export function serializeDesignDocument(document: DesignDocument): string {
	return JSON.stringify(document, null, '\t') + '\n';
}

/** Owns committed edits. A pointer gesture commits once, so undo restores the whole gesture. */
export class DesignDocumentModel extends Disposable {
	private document = documentFromShapes([]);
	private readonly undoStack: DesignDocument[] = [];
	private readonly redoStack: DesignDocument[] = [];
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChange = this.changeEmitter.event;

	public get value(): DesignDocument { return this.document; }
	public get canUndo(): boolean { return this.undoStack.length > 0; }
	public get canRedo(): boolean { return this.redoStack.length > 0; }

	public addShape(kind: DesignShape['kind'], center: DesignPoint): string {
		const shape: DesignShape = { id: generateUuid(), kind, x: center.x - 60, y: center.y - 40, width: 120, height: 80, rotation: 0, fill: '#808080' };
		this.commit([...this.document.shapes, shape]);
		return shape.id;
	}

	public updateShape(shape: DesignShape): void {
		this.commit(this.document.shapes.map(current => current.id === shape.id ? shape : current));
	}

	public removeShape(id: string): void {
		this.commit(this.document.shapes.filter(shape => shape.id !== id));
	}

	public replace(document: DesignDocument): void {
		this.document = document;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.changeEmitter.fire();
	}

	public undo(): void {
		const previous = this.undoStack.pop();
		if (previous) {
			this.redoStack.push(this.document);
			this.document = previous;
			this.changeEmitter.fire();
		}
	}

	public redo(): void {
		const next = this.redoStack.pop();
		if (next) {
			this.undoStack.push(this.document);
			this.document = next;
			this.changeEmitter.fire();
		}
	}

	private commit(shapes: readonly DesignShape[]): void {
		const next = documentFromShapes(shapes);
		if (serializeDesignDocument(next) === serializeDesignDocument(this.document)) {
			return;
		}
		this.undoStack.push(this.document);
		this.redoStack.length = 0;
		this.document = next;
		this.changeEmitter.fire();
	}
}
