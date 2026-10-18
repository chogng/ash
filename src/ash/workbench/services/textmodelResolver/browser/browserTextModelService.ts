import type { TokenizationTextModelPartOptions } from '../../../../editor/common/model/tokens/tokenizationTextModelPart.js';
import type { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Schemas } from '../../../../base/common/network.js';
import { runWhenWindowIdle } from "../../../../base/browser/dom.js";
import { TextModelConflictError, TextModelSaveCompletionError, type TextModelInput, type TextModelReference, type IFileTextModelService, type ITextModelSaveCompletionParticipant, type TextModelSaveCompletion } from "../common/textModelResourceService.js";
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
import { raceCancellationError } from '../../../../base/common/async.js';
import { SaveReason, type ISaveOptions } from '../../../common/editor.js';
import type { ITextModelSaveParticipant } from '../common/textModelResourceService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EncodingMode, type IEncodingSupport } from '../../textfile/common/textfiles.js';
import { assertEncoding } from '../../textfile/common/encoding.js';
import { localize } from '../../../../nls.js';

interface TextModelEntry {
	readonly isSnapshot: boolean;
	readonly identityLifetime: IDisposable;
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
	savedEncoding: TextResourceContent["encoding"];
	updatingFile: boolean;
	completingSave: boolean;
	dirty: boolean;
	notifiedDirty: boolean;
	hasExternalChange: boolean;
	disposed: boolean;
	saveQueue: Promise<void>;
	refresh: TextModelRefresh | undefined;
	references: number;
}

interface TextModelRefresh {
	controller: AbortController;
	invalidated: boolean;
	promise: Promise<void>;
}

interface SaveRecoveryState {
	readonly identityLifetime: IDisposable;
	readonly resource: URI;
	pending: number;
	latest: Promise<void> | undefined;
	unresolved: boolean;
	error: unknown;
}

export interface BrowserTextModelServiceOptions {
	readonly createSyntaxTokenBackend?: TokenizationTextModelPartOptions['createSyntaxTokenBackend'];
	readonly onDidChangeSyntaxBackend?: Event<void>;
	/** Browser-owned maintenance policy applied to newly acquired text models. */
	readonly maintenance?: TextModelMaintenanceOptions;
	readonly languageService?: IAshLanguageService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly syntaxService?: SyntaxServiceOptions;
	readonly onDidChangeLanguageSupport?: Event<void>;
}

/** Shares text models by provider-aware resource identity while references are open. */
export class BrowserTextModelService extends Disposable implements IFileTextModelService {
	private readonly entries = new Map<string, TextModelEntry>();
	// Failed recovery outlives forced pane disposal; retrying the same URI owns its resolution.
	private readonly saveRecovery = new Map<string, SaveRecoveryState>();
	private readonly saveParticipants = new Set<ITextModelSaveParticipant>();
	private readonly saveCompletionParticipants = new Set<ITextModelSaveCompletionParticipant>();
	private readonly undoRedoParticipant = this._register(new RetainedModelUndoRedoHistory({}, resource => this.uriIdentity.extUri.getComparisonKey(resource), resource => this.uriIdentity.retainUri(resource)));
	private readonly modelAdded = this._register(new Emitter<TextModel>());
	private readonly modelRemoved = this._register(new Emitter<TextModel>());
	private readonly modelLanguageChanged = this._register(new Emitter<{ readonly model: TextModel; readonly oldLanguageId: string; }>());
	private readonly encodingChanged = this._register(new Emitter<URI>());
	public readonly onDidChangeEncoding = this.encodingChanged.event;
	public readonly onModelAdded = this.modelAdded.event;
	public readonly onModelRemoved = this.modelRemoved.event;
	public readonly onModelLanguageChanged = this.modelLanguageChanged.event;

	public getModel(resource: URI): TextModel | null { return this.findEntry(resource)?.[1].model ?? null; }
	public getModels(): readonly TextModel[] { return [...this.entries.values()].map(entry => entry.model); }

	public getEncodingSupport(resource: URI): IEncodingSupport | undefined {
		const entry = this.findEntry(resource)?.[1];
		if (!entry || entry.encoding === undefined || (resource.scheme !== Schemas.file && resource.scheme !== Schemas.untitled && entry.revision === undefined)) return undefined;
		return {
			getEncoding: () => entry.encoding,
			setEncoding: (encoding, mode) => this.setEncoding(entry, encoding, mode),
		};
	}

	private async setEncoding(entry: TextModelEntry, encoding: string, mode: EncodingMode): Promise<void> {
		this.ensureEntryAlive(entry);
		assertEncoding(encoding);
		if (mode === EncodingMode.Encode) {
			if (entry.encoding !== encoding) {
				entry.encoding = encoding;
				this.encodingChanged.fire(entry.resource);
				this.refreshDirty(entry);
			}
			if (entry.resource.scheme !== Schemas.untitled) await this.save(entry, new AbortController().signal);
			return;
		}
		if (entry.dirty) throw new Error(localize('files.encodingDirty', 'Save or revert your changes before reopening with an encoding.'));
		const lifetime = this.reference(entry.resource.toString(), entry);
		const operation = entry.saveQueue.then(async () => {
			this.ensureEntryAlive(entry);
			if (entry.dirty) throw new Error(localize('files.encodingDirty', 'Save or revert your changes before reopening with an encoding.'));
			const version = entry.model.version;
			const previousEncoding = entry.encoding;
			const content = await this.resourceStore.resolve({ resource: entry.resource, encoding }, new AbortController().signal);
			this.ensureEntryAlive(entry);
			if (entry.dirty || entry.model.version !== version || entry.encoding !== previousEncoding) throw new Error(localize('files.encodingChangedDuringRead', 'The document changed while reopening. Your changes were preserved.'));
			this.applyFileContent(entry, content, 'revert');
			this.setExternalChange(entry, false);
		});
		entry.saveQueue = operation.catch(() => undefined);
		try { await operation; } finally { lifetime.dispose(); }
	}

	public hasPendingSaveRecovery(resource?: URI): boolean {
		const states = resource ? this.findSaveRecoveries(resource).map(([, state]) => state) : this.saveRecovery.values();
		for (const state of states) if (state && (state.pending > 0 || state.unresolved)) return true;
		return false;
	}

	public async waitForSaveRecovery(resource?: URI): Promise<void> {
		if (resource) {
			await Promise.all(this.findSaveRecoveries(resource).map(([key]) => this.waitForResourceSaveRecovery(key)));
			return;
		}
		while (this.saveRecovery.size > 0) {
			await Promise.all([...this.saveRecovery.keys()].map(key => this.waitForResourceSaveRecovery(key)));
		}
	}

	private async waitForResourceSaveRecovery(key: string): Promise<void> {
		let state: SaveRecoveryState | undefined;
		while ((state = this.saveRecovery.get(key))?.pending) {
			// Join the real result. The ordering queue deliberately consumes failures and is not evidence of recovery.
			try { await state.latest; } catch { /* The retained acknowledgement/error below decides whether leaving is safe. */ }
		}
		if (state?.unresolved) throw state.error;
	}

	public addSaveParticipant(participant: ITextModelSaveParticipant): IDisposable {
		this.assertNotDisposed();
		this.saveParticipants.add(participant);
		return toDisposable(() => this.saveParticipants.delete(participant));
	}

	public addSaveCompletionParticipant(participant: ITextModelSaveCompletionParticipant): IDisposable {
		this.assertNotDisposed();
		this.saveCompletionParticipants.add(participant);
		return toDisposable(() => this.saveCompletionParticipants.delete(participant));
	}

	constructor(private readonly resourceStore: ITextResourceStore, private readonly options: BrowserTextModelServiceOptions, @IUriIdentityService private readonly uriIdentity: IUriIdentityService) {
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
		using identityLifetime = this.uriIdentity.retainUri(input.resource);
		// Editor inputs can expose bootstrap content and language through prototype getters.
		// Canonicalize the resource without flattening away that input metadata.
		const resource = await this.uriIdentity.resolveCanonicalUri(input.resource, signal);
		throwIfCancelled(signal, "Text model acquisition was cancelled");
		this.ensureAlive();
		const key = resource.toString();
		const current = this.findEntry(resource);
		if (current) return this.acquireReference(current[0], current[1], signal);

		const content = await this.resourceStore.resolve({
			resource,
			languageId: input.languageId ?? this.options.languageService?.guessLanguageIdByFilepathOrFirstLine(resource) ?? undefined,
			...(input.initialText === undefined ? {} : { bootstrapText: input.initialText }),
			...(input.readFile === undefined ? {} : { readFile: input.readFile }),
			...(input.encoding === undefined ? {} : { encoding: input.encoding }),
		}, signal);
		throwIfCancelled(signal, "Text model acquisition was cancelled");
		this.ensureAlive();
		const concurrent = this.findEntry(resource);
		if (concurrent) {
			// A concurrent editor load may have used a broader authority. Do not replace
			// this operation's checked content with that newly published model.
			if (input.readFile) throw new TextModelConflictError(resource);
			return this.acquireReference(concurrent[0], concurrent[1], signal);
		}
		const languageSelection = this.options.languageService
			? input.languageId !== undefined
				? this.options.languageService.createById(input.languageId)
				: input.contentType !== undefined
					? this.options.languageService.createByMimeType(input.contentType)
					: this.options.languageService.createByFilepathOrFirstLine(resource, firstLine(content.text))
			: undefined;
		const model = new TextModel(modelText(content), {
			resource,
			languageConfigurationService: this.options.languageConfigurationService,
			languageId: languageSelection?.languageId ?? input.languageId,
			maintenance: this.options.maintenance,
			...(this.options.languageService && this.options.languageFeaturesService ? {
				tokenization: {
					createSyntaxTokenBackend: this.options.createSyntaxTokenBackend,
					onDidChangeSyntaxBackend: this.options.onDidChangeSyntaxBackend,
					languageIdCodec: this.options.languageService.languageIdCodec,
					syntaxProviderRegistry: this.options.languageFeaturesService.syntaxProvider,
					documentSemanticTokensProvider: this.options.languageFeaturesService.documentSemanticTokensProvider,
					...(this.options.syntaxService ? { syntaxService: this.options.syntaxService } : {}),
					...(this.options.onDidChangeLanguageSupport ? { onDidChangeLanguageSupport: this.options.onDidChangeLanguageSupport } : {}),
				},
			} : {}),
		});
		if (languageSelection) model.setLanguage(languageSelection);
		this.undoRedoParticipant.restore(resource, model);
		const dirtyEmitter = new Emitter<void>();
		const externalChangeEmitter = new Emitter<void>();
		const entry: TextModelEntry = {
			isSnapshot: input.initialText !== undefined && input.readOnly === true,
			identityLifetime: this.uriIdentity.retainUri(resource),
			resource,
			model,
			dirtyEmitter,
			externalChangeEmitter,
			modelChangeListener: model.onDidChangeContent(() => {
				if (!entry.updatingFile) {
					entry.refresh?.controller.abort();
					this.refreshDirty(entry);
				}
			}),
			languageChangeListener: model.onDidChangeLanguage(event => this.modelLanguageChanged.fire({ model, oldLanguageId: event.oldLanguage })),
			fileChangeListener: this.resourceStore.onDidChange(event => this.acceptFileChange(entry, event)),
			// Untitled content has no persisted baseline, including caller supplied initial text.
			savedText: resource.scheme === Schemas.untitled ? "" : model.getText(),
			revision: content.revision,
			encoding: content.encoding,
			savedEncoding: content.encoding,
			updatingFile: false,
			completingSave: false,
			dirty: resource.scheme === Schemas.untitled && model.getText().length > 0,
			notifiedDirty: resource.scheme === Schemas.untitled && model.getText().length > 0,
			hasExternalChange: false,
			disposed: false,
			saveQueue: Promise.resolve(),
			refresh: undefined,
			references: 0,
		};
		this.entries.set(key, entry);
		this.modelAdded.fire(model);
		return this.acquireReference(key, entry, signal);
	}

	protected override disposeCore(): void {
		this.saveParticipants.clear();
		this.saveCompletionParticipants.clear();
		for (const recovery of this.saveRecovery.values()) recovery.identityLifetime.dispose();
		this.saveRecovery.clear();
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
			save: (signal: AbortSignal, options?: ISaveOptions) => this.save(entry, signal, options),
			saveAs: (resource: URI, signal: AbortSignal) => this.saveAs(entry, resource, signal),
			revert: (signal: AbortSignal) => this.revert(entry, signal),
			dispose,
			[Symbol.dispose]: dispose,
		});
	}

	private async saveAs(entry: TextModelEntry, resource: URI, signal: AbortSignal): Promise<void> {
		this.ensureEntryAlive(entry);
		if (this.uriIdentity.extUri.isEqual(resource, entry.resource)) return this.save(entry, signal);
		const text = entry.model.getText();
		const languageId = entry.model.getLanguageId();
		const encoding = entry.encoding;
		// Save As runs against the destination so providers receive its URI and inferred language.
		using target = await this.acquire({ resource, initialText: text, ...(languageId === 'plaintext' ? {} : { languageId }) }, signal);
		const targetEntry = this.findEntry(target.resource)?.[1];
		if (targetEntry && encoding !== undefined) {
			targetEntry.encoding = encoding;
			this.encodingChanged.fire(targetEntry.resource);
			this.refreshDirty(targetEntry);
		}
		target.model.applyOperations([{ range: target.model.getFullModelRange(), text }]);
		await target.save(signal);
		if (!entry.disposed && entry.resource.scheme === Schemas.untitled && !target.isDirty) {
			// Only the captured draft was saved. Edits made during the write remain dirty.
			entry.savedText = text;
			entry.savedEncoding = encoding;
			this.refreshDirty(entry);
		}
	}

	private save(entry: TextModelEntry, signal: AbortSignal, options: ISaveOptions = {}): Promise<void> {
		this.ensureEntryAlive(entry);
		throwIfCancelled(signal, "Text model save was cancelled");
		// A queued save owns the model until its participants and write finish, even if the pane closes.
		const key = entry.resource.toString();
		const exactRecovery = this.saveRecovery.get(key);
		const recoveries: [string, SaveRecoveryState][] = exactRecovery ? [[key, exactRecovery]] : this.findSaveRecoveries(entry.resource);
		if (recoveries.length > 1) throw new Error(localize('files.ambiguousSaveRecovery', 'Cannot save {0} because its file system identity matches multiple pending recovery records.', entry.resource.toString()));
		const existingRecovery = recoveries[0];
		const recoveryKey = existingRecovery?.[0] ?? key;
		let recovery = existingRecovery?.[1];
		if (!recovery) {
			recovery = { identityLifetime: this.uriIdentity.retainUri(entry.resource), resource: entry.resource, pending: 0, latest: undefined, unresolved: false, error: undefined };
			this.saveRecovery.set(recoveryKey, recovery);
		}
		const state = recovery;
		const lifetime = this.reference(key, entry);
		state.pending++;
		let savedText = entry.model.getText();
		const encoding = entry.encoding;
		const save = entry.saveQueue.then(async () => {
			const retry = state.unresolved;
			const acknowledgements = new Map<ITextModelSaveCompletionParticipant, number | undefined>();
			entry.completingSave = this.saveCompletionParticipants.size > 0;
			try {
				if (!options.skipSaveParticipants && this.saveParticipants.size > 0) {
					this.ensureEntryAlive(entry);
					// A save must not join cleanup edits with the user's preceding input.
					entry.model.pushStackElement();
					try {
						for (const participant of this.saveParticipants) {
							throwIfCancelled(signal, 'Text model save was cancelled');
							await raceCancellationError(participant.participate(entry.model, options.reason ?? SaveReason.EXPLICIT, signal), signal);
						}
					} finally {
						if (!entry.model.isDisposed()) entry.model.pushStackElement();
					}
					// Participant edits belong to this save, not a later dirty snapshot.
					this.ensureEntryAlive(entry);
					savedText = entry.model.getText();
				}
				throwIfCancelled(signal, 'Text model save was cancelled');
				const completions: TextModelSaveCompletion[] = [];
				for (const participant of this.saveCompletionParticipants) {
					acknowledgements.set(participant, undefined);
					// Await checkpoint settlement even on cancellation: the queue still owns its model.
					const complete = await participant.prepare(entry.model, signal, {
						retry,
						acknowledge: version => acknowledgements.set(participant, version),
					});
					if (complete) completions.push(complete);
					else acknowledgements.delete(participant);
					this.ensureEntryAlive(entry);
					throwIfCancelled(signal, 'Text model save was cancelled');
				}
				let saved;
				try {
					saved = await this.resourceStore.save({
						...(options.writeElevated ? { writeElevated: true } : {}),
						...(options.unlock ? { unlock: true } : {}),
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
				entry.savedEncoding = encoding;
				entry.revision = saved.revision;
				this.setExternalChange(entry, false);
				this.refreshDirty(entry);
				try {
					// Cancellation after publication cannot leave recovery bookkeeping behind.
					for (const complete of completions) await complete(savedText);
					if (!retry || completions.length > 0) {
						state.unresolved = false;
						state.error = undefined;
					}
				} catch (error) {
					throw new TextModelSaveCompletionError(entry.resource, error);
				}
			} catch (error) {
				if (acknowledgements.size > 0) {
					state.unresolved = [...acknowledgements.values()].some(version => version !== entry.model.version);
					state.error = state.unresolved ? error : undefined;
				}
				throw error;
			} finally {
				state.pending--;
				if (state.pending === 0 && !state.unresolved) {
					this.saveRecovery.delete(recoveryKey);
					state.identityLifetime.dispose();
				}
				entry.completingSave = false;
				if (!entry.disposed) this.refreshDirty(entry);
			}
		});
		state.latest = save;
		entry.saveQueue = save.catch(() => undefined);
		return save.finally(() => lifetime.dispose());
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
				...(entry.savedEncoding === undefined ? {} : { encoding: entry.savedEncoding }),
			}, "revert");
			this.setExternalChange(entry, false);
			return;
		}
		const version = entry.model.version;
		const encoding = entry.encoding;
		const content = await this.resourceStore.resolve({ resource: entry.resource, ...(entry.savedEncoding === undefined ? {} : { encoding: entry.savedEncoding }) }, signal);
		throwIfCancelled(signal, "Text model revert was cancelled");
		this.ensureEntryAlive(entry);
		if (entry.model.version !== version || entry.encoding !== encoding) throw new Error(localize('files.encodingChangedDuringRead', 'The document changed while reopening. Your changes were preserved.'));
		this.applyFileContent(entry, content, "revert");
		this.setExternalChange(entry, false);
	}

	private refreshDirty(entry: TextModelEntry): void {
		const dirty = entry.model.getText() !== entry.savedText || entry.encoding !== entry.savedEncoding;
		const changed = entry.dirty !== dirty;
		entry.dirty = dirty;
		if (!dirty) {
			this.setExternalChange(entry, false);
		}
		// Getters stay faithful to the file. Defer only the clean notification during recovery.
		if (!dirty && entry.completingSave) return;
		if (!changed && entry.notifiedDirty === dirty) return;
		entry.notifiedDirty = dirty;
		entry.dirtyEmitter.fire();
	}

	private acceptFileChange(entry: TextModelEntry, event: TextResourceChangeEvent): void {
		if (entry.disposed || (event.resources && !event.resources.some(resource => this.uriIdentity.extUri.isEqual(resource, entry.resource)))) return;
		// Watcher events are invalidations, including workspace rescans and our own writes.
		void this.refreshEntry(entry, 'fileChange').catch(error => console.error("Could not refresh open file", error));
	}

	/** Rechecks an open file when its window regains focus and watcher events may have been missed. */
	async refresh(resource: URI): Promise<void> {
		this.ensureAlive();
		const entry = this.findEntry(resource)?.[1];
		if (entry) await this.refreshEntry(entry);
	}

	private refreshEntry(entry: TextModelEntry, reason: 'focus' | 'fileChange' = 'focus'): Promise<void> {
		if (entry.refresh) {
			if (reason === 'fileChange') {
				entry.refresh.invalidated = true;
				entry.refresh.controller.abort();
			}
			return entry.refresh.promise;
		}
		if (entry.disposed || entry.dirty || entry.isSnapshot || entry.resource.scheme === Schemas.untitled) return Promise.resolve();
		const observedSaveQueue = entry.saveQueue;
		const refresh: TextModelRefresh = { controller: new AbortController(), invalidated: false, promise: Promise.resolve() };
		entry.refresh = refresh;
		refresh.promise = (async () => {
			do {
				refresh.invalidated = false;
				refresh.controller = new AbortController();
				try {
					await this.readRefresh(entry, refresh.controller.signal);
				} catch (error) {
					if (!refresh.controller.signal.aborted) throw error;
				}
				// A mutation owns its acknowledged baseline. Watcher bursts can request
				// one fresh read, but must never replay or wait behind a newly queued save.
			} while (refresh.invalidated && !entry.disposed && !entry.dirty && entry.saveQueue === observedSaveQueue);
		})().finally(() => { if (entry.refresh === refresh) entry.refresh = undefined; });
		return refresh.promise;
	}

	private async readRefresh(entry: TextModelEntry, signal: AbortSignal): Promise<void> {
		// Snapshot models belong to their content provider, not the filesystem watcher.
		// Background reads must not advance the persisted baseline of local edits.
		if (entry.disposed || entry.dirty || entry.isSnapshot || entry.resource.scheme === Schemas.untitled) return;
		// A save can acknowledge a new revision without changing the text model version.
		const observedSaveQueue = entry.saveQueue;
		await observedSaveQueue;
		throwIfCancelled(signal);
		if (entry.disposed || entry.dirty || entry.saveQueue !== observedSaveQueue) return;
		const observedVersion = entry.model.version;
		const content = await this.resourceStore.resolve({ resource: entry.resource, ...(entry.savedEncoding === undefined ? {} : { encoding: entry.savedEncoding }) }, signal);
		throwIfCancelled(signal);
		if (entry.disposed || entry.dirty || entry.model.version !== observedVersion || entry.saveQueue !== observedSaveQueue) return;
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
			entry.savedEncoding = content.encoding;
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
		this.encodingChanged.fire(entry.resource);
		this.refreshDirty(entry);
	}

	private setExternalChange(entry: TextModelEntry, value: boolean): void {
		if (entry.hasExternalChange === value) return;
		entry.hasExternalChange = value;
		entry.externalChangeEmitter.fire();
	}

	private disposeEntry(entry: TextModelEntry): void {
		entry.disposed = true;
		entry.refresh?.controller.abort();
		this.undoRedoParticipant.remember(entry.resource, entry.model);
		entry.identityLifetime.dispose();
		entry.modelChangeListener.dispose();
		entry.languageChangeListener.dispose();
		entry.fileChangeListener.dispose();
		entry.dirtyEmitter.dispose();
		entry.externalChangeEmitter.dispose();
		// Removal observers need the final snapshot after the registry drops its
		// identity, while the model can still answer version/text requests.
		this.modelRemoved.fire(entry.model);
		entry.model.dispose();
	}

	private ensureEntryAlive(entry: TextModelEntry): void {
		if (entry.disposed) throw new ReferenceError("Text model reference is already disposed");
	}

	private findEntry(resource: URI): [string, TextModelEntry] | undefined {
		let match: [string, TextModelEntry] | undefined;
		// Provider replacement and cache eviction must not orphan an open model or silently merge two edited models.
		for (const entry of this.entries) {
			if (!this.uriIdentity.extUri.isEqual(resource, entry[1].resource)) continue;
			if (match) throw this.ambiguousIdentityError(resource);
			match = entry;
		}
		return match;
	}

	private findSaveRecoveries(resource: URI): [string, SaveRecoveryState][] {
		return [...this.saveRecovery].filter(([, state]) => this.uriIdentity.extUri.isEqual(resource, state.resource));
	}

	private ambiguousIdentityError(resource: URI): Error {
		return new Error(localize('files.ambiguousIdentity', 'The file system identity for {0} matches multiple open documents. Close the duplicate documents before reopening.', resource.toString()));
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
export function createBrowserTextModelService(resourceStore: ITextResourceStore, instantiationService: IInstantiationService, options: BrowserTextModelServiceOptions = {}): BrowserTextModelService {
	return instantiationService.createInstance(BrowserTextModelService, resourceStore, {
		...options,
		maintenance: {
			schedule: callback => runWhenWindowIdle(
				window,
				() => callback(),
				250,
			),
		},
	} satisfies BrowserTextModelServiceOptions);
}

const modelServices = new WeakMap<ITextResourceStore, BrowserTextModelService>();

/** Shares model ownership for every pane backed by one resource store. */
export function getBrowserTextModelService(resourceStore: ITextResourceStore, instantiationService: IInstantiationService, options: BrowserTextModelServiceOptions = {}): BrowserTextModelService {
	const existing = modelServices.get(resourceStore);
	if (existing) return existing;
	const service = createBrowserTextModelService(resourceStore, instantiationService, options);
	modelServices.set(resourceStore, service);
	return service;
}

function validateInput(input: TextModelInput): void {
	if (!input || typeof input !== "object" || !input.resource || typeof input.resource.toString !== "function") {
		throw new TypeError("Text model acquisition requires an editor input resource");
	}
	if (input.encoding !== undefined) assertEncoding(input.encoding);
	if (input.initialText !== undefined && typeof input.initialText !== "string") {
		throw new TypeError("Editor bootstrap content must be text");
	}
}

function modelText(content: TextResourceContent): string {
	// The buffer consumes the encoding BOM; any following U+FEFF belongs to the document.
	return content.encoding === "utf8bom" || content.text.startsWith("\uFEFF") ? "\uFEFF" + content.text : content.text;
}
