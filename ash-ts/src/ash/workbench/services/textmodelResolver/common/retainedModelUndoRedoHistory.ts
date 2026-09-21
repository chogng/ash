import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { TextModel, TextModelUndoRedoSnapshot } from '../../../../editor/common/model/textModel.js';

export interface RetainedModelUndoRedoHistoryOptions {
	readonly maxEntries?: number;
	readonly maxTextUnits?: number;
}

interface RetainedModelUndoRedo {
	readonly snapshot: TextModelUndoRedoSnapshot;
	readonly textUnits: number;
}

const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_MAX_TEXT_UNITS = 16 * 1024 * 1024;

/** Preserves bounded model-local undo and redo when a resolver releases and later recreates a model. */
export class RetainedModelUndoRedoHistory extends AbstractDisposable {
	private readonly retained = new Map<string, RetainedModelUndoRedo>();
	private readonly maxEntries: number;
	private readonly maxTextUnits: number;
	private retainedTextUnits = 0;

	constructor(options: RetainedModelUndoRedoHistoryOptions = {}) {
		super();
		this.maxEntries = readLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries');
		this.maxTextUnits = readLimit(options.maxTextUnits, DEFAULT_MAX_TEXT_UNITS, 'maxTextUnits');
	}

	public remember(resource: URI, model: TextModel): void {
		this.assertNotDisposed();
		const key = resource.toString();
		this.delete(key);
		const snapshot = model.createUndoRedoSnapshot();
		if (!snapshot) return;
		const textUnits = snapshot.contentLength + snapshot.history.textUnits;
		if (textUnits > this.maxTextUnits) return;
		this.retained.set(key, Object.freeze({ snapshot, textUnits }));
		this.retainedTextUnits += textUnits;
		this.trim();
	}

	public restore(resource: URI, model: TextModel): boolean {
		this.assertNotDisposed();
		const key = resource.toString();
		const entry = this.retained.get(key);
		if (!entry) return false;
		this.delete(key);
		return model.restoreUndoRedoSnapshot(entry.snapshot);
	}

	public forget(resource: URI): void {
		this.assertNotDisposed();
		this.delete(resource.toString());
	}

	protected disposeCore(): void {
		this.retained.clear();
		this.retainedTextUnits = 0;
	}

	private trim(): void {
		while (this.retained.size > this.maxEntries || this.retainedTextUnits > this.maxTextUnits) {
			const oldest = this.retained.keys().next().value as string | undefined;
			if (oldest === undefined) return;
			this.delete(oldest);
		}
	}

	private delete(key: string): void {
		const entry = this.retained.get(key);
		if (!entry) return;
		this.retained.delete(key);
		this.retainedTextUnits -= entry.textUnits;
	}
}

function readLimit(value: number | undefined, defaultValue: number, name: string): number {
	const result = value ?? defaultValue;
	if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`Model undo and redo ${name} must be a non-negative safe integer`);
	return result;
}
