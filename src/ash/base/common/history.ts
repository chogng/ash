import type { Event } from './event.js';
import { Disposable } from './lifecycle.js';

export interface IHistory<T> {
	delete(value: T): boolean;
	add(value: T): this;
	has(value: T): boolean;
	clear(): void;
	forEach(callback: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void;
	replace?(values: T[]): void;
	readonly onDidChange?: Event<string[]>;
}

export class HistoryNavigator<T> extends Disposable {
	private values: T[] = [];
	private position = 0;

	constructor(private readonly history: IHistory<T> = new Set<T>(), private readonly limit = 10) {
		super();
		if (limit < 1) {
			throw new RangeError('History limit must be positive');
		}
		this.refresh();
		if (history.onDidChange) {
			this._register(history.onDidChange(() => this.refresh()));
		}
	}

	public getHistory(): T[] { return [...this.values]; }

	public add(value: T): void {
		this.history.delete(value);
		this.history.add(value);
		this.refresh();
	}

	public next(): T | null {
		if (this.position < this.values.length) {
			this.position++;
		}
		return this.current();
	}

	public previous(): T | null {
		if (this.position === 0) {
			return null;
		}
		this.position--;
		return this.current();
	}

	public current(): T | null { return this.values[this.position] ?? null; }
	public first(): T | null { this.position = 0; return this.current(); }
	public last(): T | null { this.position = Math.max(0, this.values.length - 1); return this.current(); }
	public isFirst(): boolean { return this.position === 0 && this.values.length > 0; }
	public isLast(): boolean { return this.position === this.values.length - 1; }
	public isNowhere(): boolean { return this.position === this.values.length; }
	public has(value: T): boolean { return this.history.has(value); }

	public clear(): void {
		this.history.clear();
		this.refresh();
	}

	public reset(): void { this.position = this.values.length; }

	private refresh(): void {
		const values: T[] = [];
		this.history.forEach(value => values.push(value));
		if (values.length > this.limit) {
			this.values = values.slice(-this.limit);
			if (this.history.replace) {
				this.history.replace(this.values);
			} else {
				for (const value of values.slice(0, -this.limit)) {
					this.history.delete(value);
				}
			}
		} else {
			this.values = values;
		}
		this.reset();
	}
}
