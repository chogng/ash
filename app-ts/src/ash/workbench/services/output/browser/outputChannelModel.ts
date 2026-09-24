import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type { IOutputChannelChange, IOutputEntry, IOutputEntryInput, OutputEntrySeverity } from "../common/outputService.js";

const MaxRetainedEntries = 20_000;
const MaxRetainedBytes = 4 * 1024 * 1024;

/** Retained Output content contract used by channel implementations. */
export interface IOutputChannelModel {
	readonly entries: readonly IOutputEntry[];
	readonly onDidChange: Event<IOutputChannelChange>;
	append(entry: IOutputEntryInput): void;
	appendLine(entry: IOutputEntryInput): void;
	replace(entries: IOutputEntryInput | readonly IOutputEntryInput[]): void;
	clear(): void;
	getText(): string;
}

/** Bounded in-memory model for transient and frontend-owned Output streams. */
export class InMemoryOutputChannelModel extends Disposable implements IOutputChannelModel {
	private readonly changeEmitter = this._register(new Emitter<IOutputChannelChange>());
	private readonly retainedEntries: IOutputEntry[] = [];
	private retainedBytes = 0;
	private nextSequence = 1;
	readonly onDidChange = this.changeEmitter.event;

	get entries(): readonly IOutputEntry[] {
		return Object.freeze([...this.retainedEntries]);
	}

	append(input: IOutputEntryInput): void {
		const entry = this.createEntry(input);
		if (!entry) return;
		this.retain(entry);
		this.changeEmitter.fire(Object.freeze({ kind: "append", appended: Object.freeze([entry]) }));
	}

	appendLine(input: IOutputEntryInput): void {
		this.append({ ...input, text: input.text.endsWith("\n") ? input.text : `${input.text}\n` });
	}

	replace(inputs: IOutputEntryInput | readonly IOutputEntryInput[]): void {
		const candidates = (Array.isArray(inputs) ? inputs : [inputs]).map(input => this.createEntry(input)).filter((entry): entry is IOutputEntry => entry !== undefined);
		this.retainedEntries.length = 0;
		this.retainedBytes = 0;
		for (const entry of candidates) this.retain(entry);
		this.changeEmitter.fire(Object.freeze({ kind: "replace", appended: Object.freeze([...this.retainedEntries]) }));
	}

	clear(): void {
		if (this.retainedEntries.length === 0) return;
		this.retainedEntries.length = 0;
		this.retainedBytes = 0;
		this.changeEmitter.fire(Object.freeze({ kind: "clear", appended: Object.freeze([]) }));
	}

	getText(): string {
		return this.retainedEntries.map(entry => entry.text).join("");
	}

	private createEntry(input: IOutputEntryInput): IOutputEntry | undefined {
		if (typeof input.text !== "string") throw new TypeError("Output entry text must be a string");
		if (input.text.length === 0) return undefined;
		const severity = input.severity ?? "log";
		if (!isOutputEntrySeverity(severity)) throw new TypeError(`Unsupported Output entry severity: ${String(severity)}`);
		const timestamp = input.timestamp ?? Date.now();
		if (!Number.isFinite(timestamp) || timestamp < 0) throw new TypeError("Output entry timestamp must be a non-negative finite number");
		const category = normalizeCategory(input.category);
		return Object.freeze({ sequence: this.nextSequence++, timestamp, severity, ...(category ? { category } : {}), text: input.text });
	}

	private retain(entry: IOutputEntry): void {
		this.retainedEntries.push(entry);
		this.retainedBytes += retainedSize(entry);
		while (this.retainedEntries.length > MaxRetainedEntries || this.retainedBytes > MaxRetainedBytes) {
			const removed = this.retainedEntries.shift();
			if (!removed) break;
			this.retainedBytes -= retainedSize(removed);
		}
	}
}

function retainedSize(entry: IOutputEntry): number {
	return entry.text.length * 2 + (entry.category?.length ?? 0) * 2 + 32;
}

function normalizeCategory(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const category = value.trim();
	if (!category || category.includes("\0")) throw new TypeError("Output entry category must be non-empty and cannot contain null bytes");
	if (category.length > 256) throw new RangeError("Output entry category is too long");
	return category;
}

function isOutputEntrySeverity(value: unknown): value is OutputEntrySeverity {
	return value === "trace" || value === "debug" || value === "information" || value === "warning" || value === "error" || value === "log";
}
