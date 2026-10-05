import type { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Schemas } from '../../../../base/common/network.js';
import { runWhenWindowIdle } from "../../../../base/browser/dom.js";
import { TextModelConflictError, type TextModelInput, type TextModelReference, type IFileTextModelService } from "../common/textModelResourceService.js";
import { TextResourceConflictError, type TextResourceChangeEvent, type TextResourceContent, type ITextResourceStore } from "../common/textResourceStore.js";
import { ModelService } from "../../../../editor/common/services/modelService.js";
import { createPieceTreeTextBuffer } from "../../../../editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js";
import { EndOfLineSequence, EndOfLinePreference } from "../../../../editor/common/model.js";
import { Range } from "../../../../editor/common/core/range.js";
import { TextModel, type TextModelMaintenanceOptions } from "../../../../editor/common/model/textModel.js";
import { RetainedModelUndoRedoHistory } from '../common/retainedModelUndoRedoHistory.js';
import { type IAshLanguageService } from '../../../../editor/common/languages/language.js';
import { type ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { type SyntaxServiceOptions } from '../../../../editor/common/languages.js';

interface TextModelEntry {
	readonly resource: URI;
	readonly model: TextModel;
	readonly dirtyEmitter: Emitter<void>;
	readonly externalChangeEmitter: Emitter<void>;
	readonly modelChangeListener: IDisposable;
	readonly languageChangeListener: IDisposable;
	readonly fileChangeListener: IDisposable;
	savedText: string;
	revision: string | undefined;
	encoding: TextResourceContent["encoding"];
	updatingFile: boolean;
	dirty: boolean;
	hasExternalChange: boolean;
	disposed: boolean;
	saveQueue: Promise<void>;
	references: number;
}

export interface BrowserTextModelServiceOptions {
	/** Browser-owned maintenance policy applied to newly acquired text models. */
	readonly maintenance?: TextModelMaintenanceOptions;
	readonly languageService?: IAshLanguageService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly syntaxService?: SyntaxServiceOptions;
	readonly onDidChangeLanguageSupport?: Event<void>;
}

/** Shares text models by exact resource identity while references are open. */
export class BrowserTextModelService extends Disposable implements IFileTextModelService {
	private readonly entries = new Map<string, TextModelEntry>();
	private readonly undoRedoParticipant = this._register(new RetainedModelUndoRedoHistory());
	private readonly modelAdded = this._register(new Emitter<TextModel>());
	private readonly modelRemoved = this._register(new Emitter<TextModel>());
	private readonly modelLanguageChanged = this._register(new Emitter<{ readonly model: TextModel; readonly oldLanguageId: string }>());
	public readonly onModelAdded = this.modelAdded.event;
	public readonly onModelRemoved = this.modelRemoved.event;
	public readonly onModelLanguageChanged = this.modelLanguageChanged.event;

	public getModel(resource: URI): TextModel | null { return this.entries.get(resource.toString())?.model ?? null; }

	constructor(private readonly resourceStore: ITextResourceStore, private readonly options: BrowserTextModelServiceOptions = {}) {
		super();
		if (options.maintenance && typeof options.maintenance.schedule !== "function") {
			throw new TypeError("Text model maintenance requires a scheduler");
		}
		if (!resourceStore || typeof resourceStore.resolve !== "function" || typeof resourceStore.save !== "function" || typeof resourceStore.onDidChange !== "function") {
			throw new TypeError("Text model service requires a text resource store");
		}
	}

	async acquire(input: TextModelInput, signal: AbortSignal): Promise<TextModelReference> {
		this.ensureAlive();
		validateInput(input);
		throwIfCancelled(signal, "Text model acquisition was cancelled");
		const key = input.resource.toString();
		const current = this.entries.get(key);
		if (current) return this.acquireReference(key, current, signal);

		const content = await this.resourceStore.resolve({
			resource: input.resource,
			...(input.initialText === undefined ? {} : { bootstrapText: input.initialText }),
		}, signal);
		throwIfCancelled(signal, "Text model acquisition was cancelled");
		this.ensureAlive();
		const concurrent = this.entries.get(key);
		if (concurrent) return this.acquireReference(key, concurrent, signal);
		const languageSelection = this.options.languageService
			? input.languageId !== undefined
				? this.options.languageService.createById(input.languageId)
				: input.contentType !== undefined
					? this.options.languageService.createByMimeType(input.contentType)
					: this.options.languageService.createByFilepathOrFirstLine(input.resource, firstLine(content.text))
			: undefined;
		const model = new TextModel(modelText(content), {
			resource: input.resource,
			languageConfigurationService: this.options.languageConfigurationService,
			languageId: languageSelection?.languageId ?? input.languageId,
			maintenance: this.options.maintenance,
			...(this.options.languageService && this.options.languageFeaturesService ? {
					tokenization: {
						languageIdCodec: this.options.languageService.languageIdCodec,
						syntaxProviderRegistry: this.options.languageFeaturesService.syntaxProvider,
						documentSemanticTokensProvider: this.options.languageFeaturesService.documentSemanticTokensProvider,
						...(this.options.syntaxService ? { syntaxService: this.options.syntaxService } : {}),
						...(this.options.onDidChangeLanguageSupport ? { onDidChangeLanguageSupport: this.options.onDidChangeLanguageSupport } : {}),
					},
			} : {}),
		});
		if (languageSelection) model.setLanguage(languageSelection);
		this.undoRedoParticipant.restore(input.resource, model);
		const dirtyEmitter = new Emitter<void>();
		const externalChangeEmitter = new Emitter<void>();
		const entry: TextModelEntry = {
			resource: input.resource,
			model,
			dirtyEmitter,
			externalChangeEmitter,
			modelChangeListener: model.onDidChangeContent(() => {
				if (!entry.updatingFile) {
					this.refreshDirty(entry);
				}
			}),
			languageChangeListener: model.onDidChangeLanguage(event => this.modelLanguageChanged.fire({ model, oldLanguageId: event.oldLanguage })),
			fileChangeListener: this.resourceStore.onDidChange(event => this.acceptFileChange(entry, event)),
			// Untitled content has no persisted baseline, including caller supplied initial text.
			savedText: input.resource.scheme === Schemas.untitled ? "" : model.getText(),
			revision: content.revision,
			encoding: content.encoding,
			updatingFile: false,
			dirty: input.resource.scheme === Schemas.untitled && model.getText().length > 0,
			hasExternalChange: false,
			disposed: false,
			saveQueue: Promise.resolve(),
			references: 0,
		};
		this.entries.set(key, entry);
		this.modelAdded.fire(model);
		return this.acquireReference(key, entry, signal);
	}

	protected override disposeCore(): void {
		// Remove identities before notifying observers so they cannot resolve a closed model.
		for (const [key, entry] of this.entries) {
			this.entries.delete(key);
			this.disposeEntry(entry);
		}
		super.disposeCore();
	}

	private async acquireReference(key: string, entry: TextModelEntry, signal: AbortSignal): Promise<TextModelReference> {
		const reference = this.reference(key, entry);
		try {
			// Prepare lexical support before handing the model to its viewport; full-document analysis is not a file-loading gate.
			await entry.model.tokenization.whenReady(signal);
			throwIfCancelled(signal, "Text model acquisition was cancelled");
			return reference;
		} catch (error) {
			reference.dispose();
			throw error;
		}
	}

	private reference(key: string, entry: TextModelEntry): TextModelReference {
		entry.references += 1;
		let released = false;
		const dispose = (): void => {
			if (released) return;
			released = true;
			if (this.entries.get(key) !== entry) return;
			entry.references -= 1;
			if (entry.references > 0) return;
			this.entries.delete(key);
			this.disposeEntry(entry);
		};
		return Object.freeze({
			resource: entry.resource,
			model: entry.model,
			get isDirty(): boolean {
				return entry.dirty;
			},
			onDidChangeDirty: entry.dirtyEmitter.event,
			get hasExternalChange(): boolean {
				return entry.hasExternalChange;
			},
			onDidChangeExternalChange: entry.externalChangeEmitter.event,
			save: (signal: AbortSignal) => this.save(entry, signal),
			revert: (signal: AbortSignal) => this.revert(entry, signal),
			dispose,
			[Symbol.dispose]: dispose,
		});
	}

	private save(entry: TextModelEntry, signal: AbortSignal): Promise<void> {
		this.ensureEntryAlive(entry);
		throwIfCancelled(signal, "Text model save was cancelled");
		const savedText = entry.model.getText();
		const encoding = entry.encoding;
		const save = entry.saveQueue.then(async () => {
			let saved;
			try {
				saved = await this.resourceStore.save({
					resource: entry.resource,
					text: savedText,
					...(encoding === undefined ? {} : { encoding }),
					...(entry.revision === undefined ? {} : { expectedRevision: entry.revision }),
				}, signal);
			} catch (error) {
				if (error instanceof TextResourceConflictError) {
					this.setExternalChange(entry, true);
					throw new TextModelConflictError(entry.resource);
				}
				throw error;
			}
			if (entry.disposed) return;
			entry.savedText = savedText;
			entry.revision = saved.revision;
			this.setExternalChange(entry, false);
			this.refreshDirty(entry);
		});
		entry.saveQueue = save.catch(() => undefined);
		return save;
	}

	private async revert(entry: TextModelEntry, signal: AbortSignal): Promise<void> {
		this.ensureEntryAlive(entry);
		throwIfCancelled(signal, "Text model revert was cancelled");
		await entry.saveQueue;
		this.ensureEntryAlive(entry);
		if (entry.resource.scheme === Schemas.untitled) {
			this.applyFileContent(entry, {
				resource: entry.resource,
				text: entry.savedText,
				revision: entry.revision,
				...(entry.encoding === undefined ? {} : { encoding: entry.encoding }),
			}, "revert");
			this.setExternalChange(entry, false);
			return;
		}
		const content = await this.resourceStore.resolve({ resource: entry.resource }, signal);
		throwIfCancelled(signal, "Text model revert was cancelled");
		this.ensureEntryAlive(entry);
		this.applyFileContent(entry, content, "revert");
		this.setExternalChange(entry, false);
	}

	private refreshDirty(entry: TextModelEntry): void {
		const dirty = entry.model.getText() !== entry.savedText;
		if (entry.dirty === dirty) return;
		entry.dirty = dirty;
		if (!dirty) {
			this.setExternalChange(entry, false);
		}
		entry.dirtyEmitter.fire();
	}

	private acceptFileChange(entry: TextModelEntry, event: TextResourceChangeEvent): void {
		if (entry.disposed || (event.resources && !event.resources.some(resource => resource.toString() === entry.resource.toString()))) return;
		// Watcher events are invalidations, including workspace rescans and our own writes.
		void this.refresh(entry.resource).catch(error => console.error("Could not refresh open file", error));
	}

	/** Rechecks an open file when its window regains focus and watcher events may have been missed. */
	async refresh(resource: URI): Promise<void> {
		this.ensureAlive();
		const entry = this.entries.get(resource.toString());
		// Background reads must not advance the persisted baseline of local edits.
		if (!entry || entry.dirty || entry.resource.scheme === Schemas.untitled) return;
		await entry.saveQueue;
		if (entry.disposed || entry.dirty) return;
		const observedVersion = entry.model.version;
		const content = await this.resourceStore.resolve({ resource }, new AbortController().signal);
		if (entry.disposed || entry.dirty || entry.model.version !== observedVersion) return;
		if (content.revision !== undefined && content.revision === entry.revision) {
			this.setExternalChange(entry, false);
			return;
		}
		const buffer = createPieceTreeTextBuffer(modelText(content), entry.model.getOptions().defaultEOL);
		let text: string;
		try {
			const lastLine = buffer.getLineCount();
			text = buffer.getValueInRange(new Range(1, 1, lastLine, buffer.getLineLength(lastLine) + 1), EndOfLinePreference.TextDefined);
		} finally {
			buffer.dispose();
		}
		// Compare with the persisted baseline, not local edits or raw mixed-EOL bytes.
		if (text === entry.savedText && content.encoding === entry.encoding) {
			entry.revision = content.revision;
			this.setExternalChange(entry, false);
			return;
		}
		this.applyFileContent(entry, content, "reload");
		this.setExternalChange(entry, false);
	}

	private applyFileContent(entry: TextModelEntry, content: TextResourceContent, mode: "reload" | "revert"): void {
		const buffer = createPieceTreeTextBuffer(modelText(content), entry.model.getOptions().defaultEOL);
		try {
			const lastLine = buffer.getLineCount();
			entry.savedText = buffer.getValueInRange(new Range(1, 1, lastLine, buffer.getLineLength(lastLine) + 1), EndOfLinePreference.TextDefined);
			entry.revision = content.revision;
			entry.encoding = content.encoding;
			// File reloads publish one dirty transition after text and EOL are both updated.
			entry.updatingFile = true;
			if (mode === "revert") {
				entry.model.reset(modelText(content));
			} else {
				const edits = ModelService._computeEdits(entry.model, buffer);
				entry.model.pushStackElement();
				entry.model.pushEditOperations(null, edits, () => null);
				entry.model.pushEOL(buffer.getEOL() === "\r\n" ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
				entry.model.pushStackElement();
			}
		} finally {
			entry.updatingFile = false;
			buffer.dispose();
		}
		this.refreshDirty(entry);
	}

	private setExternalChange(entry: TextModelEntry, value: boolean): void {
		if (entry.hasExternalChange === value) return;
		entry.hasExternalChange = value;
		entry.externalChangeEmitter.fire();
	}

	private disposeEntry(entry: TextModelEntry): void {
		entry.disposed = true;
		this.undoRedoParticipant.remember(entry.resource, entry.model);
		entry.modelChangeListener.dispose();
		entry.languageChangeListener.dispose();
		entry.fileChangeListener.dispose();
		entry.dirtyEmitter.dispose();
		entry.externalChangeEmitter.dispose();
		entry.model.dispose();
		this.modelRemoved.fire(entry.model);
	}

	private ensureEntryAlive(entry: TextModelEntry): void {
		if (entry.disposed) throw new ReferenceError("Text model reference is already disposed");
	}

	private ensureAlive(): void {
		if (this.isDisposed) throw new ReferenceError("BrowserTextModelService is already disposed");
	}
}

function firstLine(text: string): string {
	const lineBreak = text.search(/[\r\n]/u);
	return lineBreak < 0 ? text : text.slice(0, lineBreak);
}

/** Returns a browser model service with the renderer's idle maintenance policy. */
export function createBrowserTextModelService(resourceStore: ITextResourceStore, options: BrowserTextModelServiceOptions = {}): BrowserTextModelService {
	return new BrowserTextModelService(resourceStore, {
		...options,
		maintenance: {
			schedule: callback => runWhenWindowIdle(
				window,
				() => callback(),
				250,
			),
		},
	});
}

const modelServices = new WeakMap<ITextResourceStore, BrowserTextModelService>();

/** Shares model ownership for every pane backed by one resource store. */
export function getBrowserTextModelService(resourceStore: ITextResourceStore, options: BrowserTextModelServiceOptions = {}): BrowserTextModelService {
	const existing = modelServices.get(resourceStore);
	if (existing) return existing;
	const service = createBrowserTextModelService(resourceStore, options);
	modelServices.set(resourceStore, service);
	return service;
}

function validateInput(input: TextModelInput): void {
	if (!input || typeof input !== "object" || !input.resource || typeof input.resource.toString !== "function") {
		throw new TypeError("Text model acquisition requires an editor input resource");
	}
	if (input.initialText !== undefined && typeof input.initialText !== "string") {
		throw new TypeError("Editor bootstrap content must be text");
	}
}

function modelText(content: TextResourceContent): string {
	// The buffer consumes the encoding BOM; any following U+FEFF belongs to the document.
	return content.encoding === "utf8bom" ? "\uFEFF" + content.text : content.text;
}
