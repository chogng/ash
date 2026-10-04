import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import type { IOutputChannelChange, IOutputEntry, IOutputEntryInput, OutputEntrySeverity } from "../../../services/output/common/output.js";

const MaxRetainedEntries = 20_000;
const MaxRetainedBytes = 4 * 1024 * 1024;

/** Retained Output content contract used by channel implementations. */
export interface IOutputChannelModel {
	loadModel(): Promise<ITextModel>;
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
	private textModel: ITextModel | undefined;
	private readonly modelListener = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly resource: URI,
		private readonly languageId: string,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		this._register(toDisposable(() => this.textModel?.dispose()));
	}

	public async loadModel(): Promise<ITextModel> {
		this.assertNotDisposed();
		if (!this.textModel) {
			const model = this.modelService.createModel(this.getText(), this.languageService.createById(this.languageId), this.resource);
			this.textModel = model;
			// Views borrow the model through the resolver. Retained entries outlive its last reference.
			this.modelListener.value = model.onWillDispose(() => { this.textModel = undefined; });
		}
		return this.textModel;
	}

	get entries(): readonly IOutputEntry[] {
		return Object.freeze([...this.retainedEntries]);
	}

	append(input: IOutputEntryInput): void {
		const entry = this.createEntry(input);
		if (!entry) return;
		const firstSequence = this.retainedEntries[0]?.sequence;
		const previous = this.retainedEntries.at(-1);
		this.retain(entry);
		if (this.textModel) {
			if (this.retainedEntries.at(-1) !== entry || (firstSequence !== undefined && firstSequence !== this.retainedEntries[0]?.sequence)) {
				this.modelService.updateModel(this.textModel, this.getText());
			} else {
				const line = this.textModel.getLineCount();
				const column = this.textModel.getLineMaxColumn(line);
				// A CRLF can arrive in separate writes; the model already normalized its CR.
				const text = previous?.text.endsWith('\r') && entry.text.startsWith('\n') ? entry.text.slice(1) : entry.text;
				this.textModel.applyEdits([{ range: new Range(line, column, line, column), text }]);
			}
		}
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
		if (this.textModel) this.modelService.updateModel(this.textModel, this.getText());
		this.changeEmitter.fire(Object.freeze({ kind: "replace", appended: Object.freeze([...this.retainedEntries]) }));
	}

	clear(): void {
		if (this.retainedEntries.length === 0) return;
		this.retainedEntries.length = 0;
		this.retainedBytes = 0;
		if (this.textModel) this.modelService.updateModel(this.textModel, "");
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
