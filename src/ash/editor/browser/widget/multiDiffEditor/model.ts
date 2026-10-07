import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';

export interface IDocumentDiffItem {
	readonly id: string;
	readonly label: string;
	readonly originalLabel?: string;
	readonly modifiedLabel?: string;
	readonly readOnly?: boolean;
	readonly model: DiffModel | undefined;
	readonly state: 'unresolved' | 'loading' | 'ready' | 'error';
	readonly error: Error | undefined;
	readonly onDidChange: Event<void>;
	resolve(): Promise<DiffModel>;
}

export interface IMultiDiffEditorModel {
	readonly items: readonly IDocumentDiffItem[];
	readonly onDidChangeItems: Event<readonly IDocumentDiffItem[]>;
}

/** Owns the ordered comparison list; individual items remain caller-owned. */
export class MultiDiffEditorModel extends Disposable implements IMultiDiffEditorModel {
	private readonly itemsEmitter = this._register(new Emitter<readonly IDocumentDiffItem[]>());
	private currentItems: readonly IDocumentDiffItem[];
	public readonly onDidChangeItems: Event<readonly IDocumentDiffItem[]> = this.itemsEmitter.event;

	constructor(items: readonly IDocumentDiffItem[]) {
		super();
		validateDocumentDiffItems(items);
		this.currentItems = Object.freeze([...items]);
	}

	public get items(): readonly IDocumentDiffItem[] {
		return this.currentItems;
	}

	public setItems(items: readonly IDocumentDiffItem[]): void {
		this.assertNotDisposed();
		validateDocumentDiffItems(items);
		if (items.length === this.currentItems.length && items.every((item, index) => item === this.currentItems[index])) return;
		this.currentItems = Object.freeze([...items]);
		this.itemsEmitter.fire(this.currentItems);
	}
}

export function validateDocumentDiffItems(items: readonly IDocumentDiffItem[]): void {
	if (!Array.isArray(items)) throw new TypeError('Multi-diff editor items must be an array');
	const ids = new Set<string>();
	for (const item of items) {
		if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0 || typeof item.label !== 'string' || item.label.trim().length === 0 || typeof item.resolve !== 'function' || typeof item.onDidChange !== 'function') {
			throw new TypeError('Multi-diff editor items require a unique ID, label, and resolvable model');
		}
		if (ids.has(item.id)) throw new TypeError(`Duplicate multi-diff item ID '${item.id}'`);
		ids.add(item.id);
		if (item.readOnly !== undefined && typeof item.readOnly !== 'boolean') throw new TypeError('Multi-diff item read-only state must be boolean');
	}
}

export interface DocumentDiffItemDescriptor {
	readonly id: string;
	readonly label: string;
	readonly originalLabel?: string;
	readonly modifiedLabel?: string;
	readonly readOnly?: boolean;
}

/** Resolves one comparison once; the caller retains ownership of its DiffModel. */
export class DocumentDiffItem extends Disposable implements IDocumentDiffItem {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly load: () => Promise<DiffModel>;
	private resolvedModel: DiffModel | undefined;
	private pending: Promise<DiffModel> | undefined;
	private currentState: IDocumentDiffItem['state'];
	private loadError: Error | undefined;
	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor(
		private readonly descriptor: DocumentDiffItemDescriptor,
		model: DiffModel | (() => Promise<DiffModel>),
	) {
		super();
		if (typeof model === 'function') {
			this.load = model;
			this.currentState = 'unresolved';
		} else {
			this.resolvedModel = model;
			this.load = async () => model;
			this.currentState = 'ready';
		}
	}

	public get id(): string { return this.descriptor.id; }
	public get label(): string { return this.descriptor.label; }
	public get originalLabel(): string | undefined { return this.descriptor.originalLabel; }
	public get modifiedLabel(): string | undefined { return this.descriptor.modifiedLabel; }
	public get readOnly(): boolean | undefined { return this.descriptor.readOnly; }
	public get model(): DiffModel | undefined { return this.resolvedModel; }
	public get state(): IDocumentDiffItem['state'] { return this.currentState; }
	public get error(): Error | undefined { return this.loadError; }

	public resolve(): Promise<DiffModel> {
		if (this.isDisposed) return Promise.reject(new Error(`Comparison '${this.id}' has been disposed`));
		if (this.resolvedModel) return Promise.resolve(this.resolvedModel);
		if (this.pending) return this.pending;
		this.currentState = 'loading';
		this.pending = this.loadOnce();
		this.changeEmitter.fire();
		return this.pending;
	}

	private async loadOnce(): Promise<DiffModel> {
		try {
			// Let resolve() publish the pending promise before the loader can change state.
			await Promise.resolve();
			const model = await this.load();
			if (this.isDisposed) throw new Error(`Comparison '${this.id}' was disposed while loading`);
			this.resolvedModel = model;
			this.currentState = 'ready';
			this.changeEmitter.fire();
			return model;
		} catch (error) {
			if (this.isDisposed) throw error;
			this.loadError = error instanceof Error ? error : new Error(String(error));
			this.currentState = 'error';
			this.changeEmitter.fire();
			throw this.loadError;
		}
	}
}
