import { Position } from "../core/position.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { Range } from "../core/range.js";
import { TextModel } from "./textModel.js";
import { type IModelDecorationOptions, TrackedRangeStickiness } from '../model.js';

declare const textDecorationIdBrand: unique symbol;

export type TextDecorationId = number & {
	readonly [textDecorationIdBrand]: "TextDecorationId";
};

export interface TextDecorationSpec<TMetadata> {
	readonly range: Range;
	readonly stickiness: TrackedRangeStickiness;
	readonly options?: Omit<IModelDecorationOptions, 'stickiness'>;
	readonly metadata: TMetadata;
}

export interface TextDecorationSnapshot<TMetadata> {
	readonly id: TextDecorationId;
	readonly range: Range;
	readonly metadata: TMetadata;
}

export enum TextDecorationChangeReason {
	Content = "content",
	Range = "range",
}

export interface TextDecorationChange<TMetadata> {
	readonly reason: TextDecorationChangeReason;
	readonly modelVersion: number;
	readonly decorations: readonly TextDecorationSnapshot<TMetadata>[];
}

interface DecorationEntry<TMetadata> {
	readonly id: TextDecorationId;
	readonly modelDecorationId: string;
	readonly metadata: TMetadata;
	lastRange: Range;
}

let nextTextDecorationId = 1;

/**
 * One owner's decorations over a shared text model.
 *
 * Metadata is opaque to core and remains caller-owned. Renderer styling,
 * language semantics, diagnostics, and search-match policy stay outside this
 * collection.
 */
export class TextDecorationCollection<TMetadata> extends Disposable {
	private readonly changeEmitter =
		this._register(new Emitter<TextDecorationChange<TMetadata>>());
	private readonly entries =
		new Map<TextDecorationId, DecorationEntry<TMetadata>>();
	private readonly ownerId = 0;

	readonly onDidChange: Event<TextDecorationChange<TMetadata>> =
		this.changeEmitter.event;

	constructor(private readonly model: TextModel) {
		super();
		this._register(model.onDidChangeContent(() => this.acceptModelChange()));
		this._register(toDisposable(() => {
			if (!this.model.isDisposed() && this.entries.size > 0) {
				this.model.deltaDecorations([...this.entries.values()].map(entry => entry.modelDecorationId), [], this.ownerId);
			}
			this.entries.clear();
		}));
	}

	get size(): number {
		this.assertNotDisposed();
		return this.entries.size;
	}

	get textModel(): TextModel {
		this.assertNotDisposed();
		return this.model;
	}

	get decorations(): readonly TextDecorationSnapshot<TMetadata>[] {
		this.assertNotDisposed();
		return this.createSnapshot();
	}

	get(
		id: TextDecorationId,
	): TextDecorationSnapshot<TMetadata> | undefined {
		this.assertNotDisposed();
		const entry = this.entries.get(id);
		return entry ? snapshotEntry(entry, this.readRange(entry)) : undefined;
	}

	add(spec: TextDecorationSpec<TMetadata>): TextDecorationId {
		this.assertNotDisposed();
		this.validateSpec(spec);
		const entry = this.createEntry(spec);
		this.entries.set(entry.id, entry);
		this.emitChange(TextDecorationChangeReason.Content);
		return entry.id;
	}

	update(
		id: TextDecorationId,
		spec: TextDecorationSpec<TMetadata>,
	): void {
		this.assertNotDisposed();
		const previous = this.entries.get(id);
		if (!previous) {
			throw new RangeError(`Unknown text decoration ${id}`);
		}
		this.validateSpec(spec);
		const [modelDecorationId] = this.model.deltaDecorations([previous.modelDecorationId], [toModelDecoration(spec)], this.ownerId);
		const next: DecorationEntry<TMetadata> = {
			id,
			modelDecorationId,
			metadata: spec.metadata,
			lastRange: spec.range,
		};
		this.entries.set(id, next);
		this.emitChange(TextDecorationChangeReason.Content);
	}

	delete(id: TextDecorationId): boolean {
		this.assertNotDisposed();
		const entry = this.entries.get(id);
		if (!entry) return false;
		this.model.deltaDecorations([entry.modelDecorationId], [], this.ownerId);
		this.entries.delete(id);
		this.emitChange(TextDecorationChangeReason.Content);
		return true;
	}

	replaceAll(
		specs: readonly TextDecorationSpec<TMetadata>[],
	): readonly TextDecorationId[] {
		return this.deltaDecorations([...this.entries.keys()], specs);
	}

	/** Atomically replaces one caller-owned decoration list while retaining reusable IDs. */
	deltaDecorations(previousIds: readonly TextDecorationId[], specs: readonly TextDecorationSpec<TMetadata>[]): readonly TextDecorationId[] {
		this.assertNotDisposed();
		for (const spec of specs) this.validateSpec(spec);
		const previousEntries = previousIds.map(id => {
			const entry = this.entries.get(id);
			if (!entry) throw new RangeError(`Unknown text decoration ${id}`);
			return entry;
		});
		if (new Set(previousIds).size !== previousIds.length) throw new RangeError("Text decoration delta contains duplicate IDs");
		if (previousIds.length === 0 && specs.length === 0) return Object.freeze([]);

		const modelDecorationIds = this.model.deltaDecorations(
			previousEntries.map(entry => entry.modelDecorationId),
			specs.map(toModelDecoration),
			this.ownerId,
		);
		const staged = specs.map((spec, index) => this.createEntryWithId(
			previousEntries[index]?.id ?? nextDecorationId(),
			modelDecorationIds[index],
			spec,
		));

		for (const entry of previousEntries) this.entries.delete(entry.id);
		for (const entry of staged) this.entries.set(entry.id, entry);
		this.emitChange(TextDecorationChangeReason.Content);
		return Object.freeze(staged.map(entry => entry.id));
	}

	clear(): void {
		this.replaceAll([]);
	}

	private createEntry(
		spec: TextDecorationSpec<TMetadata>,
	): DecorationEntry<TMetadata> {
		const [modelDecorationId] = this.model.deltaDecorations([], [toModelDecoration(spec)], this.ownerId);
		return this.createEntryWithId(nextDecorationId(), modelDecorationId, spec);
	}

	private createEntryWithId(id: TextDecorationId, modelDecorationId: string, spec: TextDecorationSpec<TMetadata>): DecorationEntry<TMetadata> {
		return {
			id,
			modelDecorationId,
			metadata: spec.metadata,
			lastRange: spec.range,
		};
	}

	private validateSpec(spec: TextDecorationSpec<TMetadata>): void {
		this.model.offsetAt(spec.range.getStartPosition());
		this.model.offsetAt(spec.range.getEndPosition());
	}

	private acceptModelChange(): void {
		let changed = false;
		for (const entry of this.entries.values()) {
			const range = this.model.getDecorationRange(entry.modelDecorationId);
			if (!range) throw new Error(`Model decoration '${entry.modelDecorationId}' was removed outside its owner`);
			if (!rangesEqual(range, entry.lastRange)) {
				entry.lastRange = range;
				changed = true;
			}
		}
		if (changed) this.emitChange(TextDecorationChangeReason.Range);
	}

	private createSnapshot(): readonly TextDecorationSnapshot<TMetadata>[] {
		return Object.freeze(
			[...this.entries.values()].map(entry => snapshotEntry(entry, this.readRange(entry))),
		);
	}

	private readRange(entry: DecorationEntry<TMetadata>): Range {
		const range = this.model.getDecorationRange(entry.modelDecorationId);
		if (!range) throw new Error(`Model decoration '${entry.modelDecorationId}' was removed outside its owner`);
		return range;
	}

	private emitChange(reason: TextDecorationChangeReason): void {
		this.changeEmitter.fire(Object.freeze({
			reason,
			modelVersion: this.model.version,
			decorations: this.createSnapshot(),
		}));
	}

}

function snapshotEntry<TMetadata>(
	entry: DecorationEntry<TMetadata>,
	range: Range,
): TextDecorationSnapshot<TMetadata> {
	return Object.freeze({
		id: entry.id,
		range,
		metadata: entry.metadata,
	});
}

function nextDecorationId(): TextDecorationId {
	const id = nextTextDecorationId as TextDecorationId;
	nextTextDecorationId += 1;
	return id;
}

function toModelDecoration<TMetadata>(spec: TextDecorationSpec<TMetadata>) {
	return {
		range: spec.range,
		options: {
			...(spec.options ?? { description: 'TextDecorationCollection' }),
			stickiness: spec.stickiness,
		},
	};
}

function rangesEqual(left: Range, right: Range): boolean {
	return Position.compare(left.getStartPosition(), right.getStartPosition()) === 0 &&
		Position.compare(left.getEndPosition(), right.getEndPosition()) === 0;
}
