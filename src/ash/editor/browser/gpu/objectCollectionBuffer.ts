import { Emitter, type Event } from '../../../base/common/event.js';
import { AbstractDisposable, Disposable, dispose, type IDisposable } from '../../../base/common/lifecycle.js';
import { BufferDirtyTracker, type IBufferDirtyTrackerReader } from './bufferDirtyTracker.js';

export interface ObjectCollectionBufferPropertySpec {
	readonly name: string;
}

export type ObjectCollectionPropertyValues<T extends readonly ObjectCollectionBufferPropertySpec[]> = {
	[K in T[number]['name']]: number;
};

export interface IObjectCollectionBuffer<T extends readonly ObjectCollectionBufferPropertySpec[]> extends IDisposable {
	readonly buffer: ArrayBufferLike;
	readonly view: Float32Array;
	readonly bufferUsedSize: number;
	readonly viewUsedSize: number;
	readonly entryCount: number;
	readonly dirtyTracker: IBufferDirtyTrackerReader;
	readonly onDidChange: Event<void>;
	readonly onDidChangeBuffer: Event<void>;
	createEntry(data: ObjectCollectionPropertyValues<T>): IObjectCollectionBufferEntry<T>;
}

export interface IObjectCollectionBufferEntry<T extends readonly ObjectCollectionBufferPropertySpec[]> extends IDisposable {
	set(propertyName: T[number]['name'], value: number): void;
	get(propertyName: T[number]['name']): number;
	setRaw(data: ArrayLike<number>): void;
}

export function createObjectCollectionBuffer<T extends readonly ObjectCollectionBufferPropertySpec[]>(propertySpecs: T, capacity: number): IObjectCollectionBuffer<T> {
	return new ObjectCollectionBuffer(propertySpecs, capacity);
}

class ObjectCollectionBuffer<T extends readonly ObjectCollectionBufferPropertySpec[]> extends Disposable implements IObjectCollectionBuffer<T> {
	private mutableView: Float32Array;
	private readonly offsets = new Map<string, number>();
	private readonly entries: ObjectCollectionBufferEntry<T>[] = [];
	private readonly tracker = new BufferDirtyTracker();
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly bufferChangeEmitter = this._register(new Emitter<void>());
	private mutableCapacity: number;

	constructor(private readonly propertySpecs: T, capacity: number) {
		super();
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Object collection buffer capacity must be a positive integer');
		if (propertySpecs.length < 1) throw new RangeError('Object collection buffer requires at least one property');
		this.mutableCapacity = capacity;
		this.mutableView = new Float32Array(capacity * propertySpecs.length);
		for (const [index, property] of propertySpecs.entries()) {
			if (this.offsets.has(property.name)) throw new Error(`Duplicate object collection property: ${property.name}`);
			this.offsets.set(property.name, index);
		}
	}

	public get buffer(): ArrayBufferLike { return this.mutableView.buffer; }
	public get view(): Float32Array { return this.mutableView; }
	public get bufferUsedSize(): number { return this.viewUsedSize * Float32Array.BYTES_PER_ELEMENT; }
	public get viewUsedSize(): number { return this.entries.length * this.propertySpecs.length; }
	public get entryCount(): number { return this.entries.length; }
	public get dirtyTracker(): IBufferDirtyTrackerReader { return this.tracker; }
	public get onDidChange(): Event<void> { return this.changeEmitter.event; }
	public get onDidChangeBuffer(): Event<void> { return this.bufferChangeEmitter.event; }

	public createEntry(data: ObjectCollectionPropertyValues<T>): IObjectCollectionBufferEntry<T> {
		if (this.entries.length === this.mutableCapacity) this.expand();
		const entry = new ObjectCollectionBufferEntry(this.mutableView, this.offsets, this.tracker, this.entries.length, data, removed => this.remove(removed), () => this.changeEmitter.fire());
		this.entries.push(entry);
		return entry;
	}

	protected override disposeCore(): void {
		dispose([...this.entries]);
		super.disposeCore();
	}

	private expand(): void {
		this.mutableCapacity *= 2;
		const next = new Float32Array(this.mutableCapacity * this.propertySpecs.length);
		next.set(this.mutableView);
		this.mutableView = next;
		for (const entry of this.entries) entry.replaceView(next);
		this.bufferChangeEmitter.fire();
	}

	private remove(entry: ObjectCollectionBufferEntry<T>): void {
		const index = this.entries.indexOf(entry);
		if (index < 0) return;
		this.entries.splice(index, 1);
		const entrySize = this.propertySpecs.length;
		this.mutableView.copyWithin(index * entrySize, (index + 1) * entrySize, (this.entries.length + 1) * entrySize);
		this.mutableView.fill(0, this.entries.length * entrySize, (this.entries.length + 1) * entrySize);
		for (let current = index; current < this.entries.length; current += 1) this.entries[current].setIndex(current);
		if (this.entries.length >= index) this.tracker.flag(index * entrySize, Math.max(1, (this.entries.length - index + 1) * entrySize));
		this.changeEmitter.fire();
	}
}

class ObjectCollectionBufferEntry<T extends readonly ObjectCollectionBufferPropertySpec[]> extends AbstractDisposable implements IObjectCollectionBufferEntry<T> {
	private mutableView: Float32Array;
	private index: number;

	constructor(view: Float32Array, private readonly offsets: ReadonlyMap<string, number>, private readonly tracker: BufferDirtyTracker, index: number, data: ObjectCollectionPropertyValues<T>, private readonly remove: (entry: ObjectCollectionBufferEntry<T>) => void, private readonly changed: () => void) {
		super();
		this.mutableView = view;
		this.index = index;
		for (const [name, offset] of offsets) this.mutableView[index * offsets.size + offset] = data[name as keyof typeof data];
		this.tracker.flag(index * offsets.size, offsets.size);
	}

	public set(propertyName: T[number]['name'], value: number): void {
		this.assertNotDisposed();
		const offset = this.offsets.get(propertyName);
		if (offset === undefined) throw new Error(`Unknown object collection property: ${propertyName}`);
		this.mutableView[this.tracker.flag(this.index * this.offsets.size + offset)] = value;
		this.changed();
	}

	public get(propertyName: T[number]['name']): number {
		this.assertNotDisposed();
		const offset = this.offsets.get(propertyName);
		if (offset === undefined) throw new Error(`Unknown object collection property: ${propertyName}`);
		return this.mutableView[this.index * this.offsets.size + offset];
	}

	public setRaw(data: ArrayLike<number>): void {
		this.assertNotDisposed();
		if (data.length !== this.offsets.size) throw new RangeError('Object collection entry data does not match its property count');
		this.mutableView.set(data, this.index * this.offsets.size);
		this.tracker.flag(this.index * this.offsets.size, this.offsets.size);
		this.changed();
	}

	public replaceView(view: Float32Array): void { this.mutableView = view; }
	public setIndex(index: number): void { this.index = index; }

	protected override disposeCore(): void {
		this.remove(this);
	}
}
