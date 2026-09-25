import type { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { runWhenWindowIdle } from "../../../../base/browser/dom.js";
import { TextModelConflictError, type TextModelInput, type TextModelReference, type IFileTextModelService } from "../common/textModelResourceService.js";
import { TextResourceConflictError, type TextResourceChangeEvent, type ITextResourceStore } from "../common/textResourceStore.js";
import { normalizeTextLineEndings } from "../../../../editor/common/core/textChange.js";
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
	readonly fileChangeListener: IDisposable;
	savedText: string;
	revision: string | undefined;
	lineEnding: ExternalLineEnding;
	dirty: boolean;
	hasExternalChange: boolean;
	disposed: boolean;
	saveQueue: Promise<void>;
	references: number;
}

enum ExternalLineEnding {
	LF = "\n",
	CRLF = "\r\n",
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
export class BrowserTextModelService implements IFileTextModelService {
	private readonly entries = new Map<string, TextModelEntry>();
	private readonly undoRedoParticipant = new RetainedModelUndoRedoHistory();
	private disposed = false;

	constructor(private readonly resourceStore: ITextResourceStore, private readonly options: BrowserTextModelServiceOptions = {}) {
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
		if (current) return this.reference(key, current);

		const content = await this.resourceStore.resolve({
			resource: input.resource,
			...(input.initialText === undefined ? {} : { bootstrapText: input.initialText }),
		}, signal);
		throwIfCancelled(signal, "Text model acquisition was cancelled");
		this.ensureAlive();
		const concurrent = this.entries.get(key);
		if (concurrent) return this.reference(key, concurrent);
		const languageSelection = this.options.languageService
			? input.languageId !== undefined
				? this.options.languageService.createById(input.languageId)
				: input.contentType !== undefined
					? this.options.languageService.createByMimeType(input.contentType)
					: this.options.languageService.createByFilepathOrFirstLine(input.resource, firstLine(content.text))
			: undefined;
		const model = new TextModel(content.text, {
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
			modelChangeListener: model.onDidChangeContent(() => this.refreshDirty(entry)),
			fileChangeListener: this.resourceStore.onDidChange(event => this.acceptFileChange(entry, event)),
			savedText: model.getText(),
			revision: content.revision,
			lineEnding: detectExternalLineEnding(content.text),
			dirty: false,
			hasExternalChange: false,
			disposed: false,
			saveQueue: Promise.resolve(),
			references: 0,
		};
		this.entries.set(key, entry);
		return this.reference(key, entry);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.entries.values()) this.disposeEntry(entry);
		this.entries.clear();
		this.undoRedoParticipant.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
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
		const save = entry.saveQueue.then(async () => {
			let saved;
			try {
				saved = await this.resourceStore.save({ resource: entry.resource, text: toExternalLineEndings(savedText, entry.lineEnding), ...(entry.revision === undefined ? {} : { expectedRevision: entry.revision }) }, signal);
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
		const content = await this.resourceStore.resolve({ resource: entry.resource }, signal);
		throwIfCancelled(signal, "Text model revert was cancelled");
		this.ensureEntryAlive(entry);
		this.applyFileContent(entry, content.text, content.revision);
		this.setExternalChange(entry, false);
	}

	private refreshDirty(entry: TextModelEntry): void {
		const dirty = entry.model.getText() !== entry.savedText;
		if (entry.dirty === dirty) return;
		entry.dirty = dirty;
		entry.dirtyEmitter.fire();
	}

	private acceptFileChange(entry: TextModelEntry, event: TextResourceChangeEvent): void {
		if (entry.disposed || (event.resources && !event.resources.some(resource => resource.toString() === entry.resource.toString()))) return;
		if (entry.dirty) {
			this.setExternalChange(entry, true);
			return;
		}
		const observedVersion = entry.model.version;
		void entry.saveQueue.then(async () => {
			const content = await this.resourceStore.resolve({ resource: entry.resource }, new AbortController().signal);
			if (entry.disposed) return;
			if (entry.dirty || entry.model.version !== observedVersion) {
				this.setExternalChange(entry, true);
				return;
			}
			if (content.text === entry.savedText) {
				entry.lineEnding = detectExternalLineEnding(content.text);
				entry.revision = content.revision;
				this.setExternalChange(entry, false);
				return;
			}
			this.applyFileContent(entry, content.text, content.revision);
			this.setExternalChange(entry, false);
		}).catch(() => {
			if (!entry.disposed) this.setExternalChange(entry, true);
		});
	}

	/** Rechecks an open file when its window regains focus and watcher events may have been missed. */
	async refresh(resource: URI): Promise<void> {
		this.ensureAlive();
		const entry = this.entries.get(resource.toString());
		if (!entry) return;
		await entry.saveQueue;
		if (entry.disposed) return;
		const observedVersion = entry.model.version;
		const content = await this.resourceStore.resolve({ resource }, new AbortController().signal);
		if (entry.disposed || content.revision === entry.revision) return;
		if (entry.dirty || entry.model.version !== observedVersion) {
			this.setExternalChange(entry, true);
			return;
		}
		this.applyFileContent(entry, content.text, content.revision);
		this.setExternalChange(entry, false);
	}

	private applyFileContent(entry: TextModelEntry, text: string, revision: string | undefined): void {
		entry.savedText = text;
		entry.revision = revision;
		entry.lineEnding = detectExternalLineEnding(text);
		entry.model.reset(text);
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
		entry.fileChangeListener.dispose();
		entry.dirtyEmitter.dispose();
		entry.externalChangeEmitter.dispose();
		entry.model.dispose();
	}

	private ensureEntryAlive(entry: TextModelEntry): void {
		if (entry.disposed) throw new ReferenceError("Text model reference is already disposed");
	}

	private ensureAlive(): void {
		if (this.disposed) throw new ReferenceError("BrowserTextModelService is already disposed");
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

function detectExternalLineEnding(text: string): ExternalLineEnding {
	return text.includes("\r\n") ? ExternalLineEnding.CRLF : ExternalLineEnding.LF;
}

function toExternalLineEndings(text: string, lineEnding: ExternalLineEnding): string {
	const normalized = normalizeTextLineEndings(text);
	return lineEnding === ExternalLineEnding.CRLF ? normalized.replaceAll("\n", "\r\n") : normalized;
}
