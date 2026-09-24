import { SyntaxProviderRegistry } from '../languageFeatureRegistry.js';
import * as languages from '../languages.js';
import { SyntaxProviderWorker } from '../services/editorWebWorker.js';
import { LanguageRequestCoordinator } from './languageRequestCoordinator.js';
import { createLanguageDiagnosticStore } from './languageResultStore.js';
import { Emitter, type Event } from "../../../base/common/event.js";
import { BugIndicatingError, onUnexpectedError } from '../../../base/common/errors.js';
import { StringSHA1 } from '../../../base/common/hash.js';
import { Disposable, DisposableStore, MutableDisposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import * as strings from '../../../base/common/strings.js';
import { URI } from "../../../base/common/uri.js";
import { LengthEdit, LengthReplacement } from "../core/edits/lengthEdit.js";
import { TextEdit } from '../core/edits/textEdit.js';
import { ColorizedBracketPairsDecorationProvider } from './bracketPairsTextModelPart/colorizedBracketPairsDecorationProvider.js';
import type { DecorationProvider } from './decorationProvider.js';
import { countEOL } from "../core/misc/eolCounter.js";
import { normalizeIndentation } from '../core/misc/indentation.js';
import { EDITOR_MODEL_DEFAULTS } from '../core/misc/textModelDefaults.js';
import { OffsetRange } from "../core/ranges/offsetRange.js";
import { type IPosition, Position } from "../core/position.js";
import { type IRange, Range } from "../core/range.js";
import { Selection } from '../core/selection.js';
import { DEFAULT_WORD_REGEXP, getWordAtText, type IWordAtPosition } from '../core/wordHelper.js';
import { compressConsecutiveTextChanges, TextModelChangeReason, type TextChange, type TextModelChange, type TextModelContentChange, type TextSnapshot } from "../core/textChange.js";
import { TextEditHistoryMergeMode, type ISingleEditOperation } from "../core/editOperation.js";
import { TextLength } from "../core/text/textLength.js";
import { canCoalesceHistoryEdits, canReplaceHistoryEdits, coalesceHistoryUndoEdits, normalizeInverseEdits, replaceHistoryUndoEdits, type OffsetTextEdit } from "./historyCoalescing.js";
import { guessIndentation } from './indentationGuesser.js';
import { findNextTextMatch, findTextMatches, TextSearchPatternKind, type TextSearchMatch, type TextModelSearchQuery } from './textModelSearch.js';
import { TextModelHistory, type TextModelHistoryEntry, type TextModelHistorySnapshot } from "./editStack.js";
import { TrackedRangeCollection, type TrackedRange } from "./trackedRange.js";
import type { DocumentSelection } from "../core/documentSelection.js";
import type { DocumentMark, DocumentNode } from "./document.js";
import type { DocumentHistoryEntries } from "./documentHistory.js";
import type { DocumentPluginKey } from "./documentPlugin.js";
import type { DocumentSchema } from "./documentSchema.js";
import type { DocumentTransaction } from "./documentTransaction.js";
import { TextModelBlockState, TextModelRemoteHistoryPolicy, type TextModelBlockChange, type TextModelBlockOptions, type TextModelPluginDecorationSource } from "./textModelBlockState.js";
import { projectDocumentToLines } from "./lineDocumentProjection.js";
import { createLineDocumentSnapshot, linePoint, type LineDocumentSnapshot, type LineId, type LinePoint, type LineSemanticAttributes } from "./lineDocument.js";
import * as model from '../model.js';
import { DefaultEndOfLine, EndOfLinePreference, EndOfLineSequence, FindMatch, PositionAffinity, TextModelResolvedOptions, TrackedRangeStickiness, ValidAnnotatedEditOperation, isITextSnapshot, type BracketPairColorizationOptions, type IAttachedView, type ICursorStateComputer, type IIdentifiedSingleEditOperation, type IModelDecorationOptions, type IModelDecorationsChangeAccessor, type IModelDeltaDecoration, type ITextBuffer, type ITextModel, type ITextModelUpdateOptions, type ITextSnapshot, type IValidEditOperation } from '../model.js';
import { type SyntaxRequest, SYNTAX_DIAGNOSTIC_LANE, type SyntaxLane, type SyntaxResult } from '../languages.js';
import { InternalModelContentChangeEvent, LineInjectedText, ModelFontChanged, ModelFontChangedEvent, ModelInjectedTextChangedEvent, ModelLineHeightChanged, ModelLineHeightChangedEvent, ModelRawContentChangedEvent, ModelRawEOLChanged, ModelRawFlush, ModelRawLineChanged, type IModelContentChangedEvent, type IModelDecorationsChangedEvent, type IModelLanguageChangedEvent, type IModelLanguageConfigurationChangedEvent, type IModelOptionsChangedEvent, type IModelTokensChangedEvent } from '../textModelEvents.js';
import type { ILanguageSelection } from '../languages/language.js';
import { ResolvedLanguageConfiguration, type ILanguageConfigurationService } from '../languages/languageConfigurationRegistry.js';
import { EditSources, type TextModelEditSource } from '../textModelEditSource.js';
import { UndoRedoGroup } from '../../../platform/undoRedo/common/undoRedo.js';
import type { IBracketPairsTextModelPart } from '../textModelBracketPairs.js';
import { BracketPairsTextModelPart } from './bracketPairsTextModelPart/bracketPairsImpl.js';
import { TokenizationTextModelPart, type TokenizationTextModelPartOptions } from './tokens/tokenizationTextModelPart.js';
import { LineTokens } from '../tokens/lineTokens.js';
import { GuidesTextModelPart } from './guidesTextModelPart.js';
import type { IViewModel } from '../viewModel.js';
import { createPieceTreeTextBuffer } from './pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js';

interface OffsetEdit extends OffsetTextEdit {}

interface AnnotatedOffsetEdit extends OffsetEdit {
	readonly identifier: IIdentifiedSingleEditOperation['identifier'];
	readonly forceMoveMarkers: boolean;
	readonly isAutoWhitespaceEdit: boolean;
	readonly _isTracked: boolean;
}

interface PreparedEdit extends AnnotatedOffsetEdit {
	readonly range: Range;
	readonly replacedText: string;
}

interface ModelDecorationEntry {
	readonly id: string;
	readonly ownerId: number;
	readonly trackedRange: TrackedRange;
	readonly options: IModelDecorationOptions;
}

interface CommitContext {
	readonly reason: TextModelChangeReason;
	readonly editSource?: TextModelEditSource;
	readonly eol?: EndOfLineSequence;
	readonly transactionId?: number;
	readonly lineIds?: readonly LineId[];
	readonly resultingSelection?: Selection[] | null;
	readonly cursorStateComputer?: ICursorStateComputer | null;
}

interface CommitResult {
	readonly change: TextModelChange;
	readonly inverseEdits: OffsetEdit[];
	readonly inverseEditOperations: IValidEditOperation[];
	readonly textChanges: TextChange[];
	readonly previousLineIds: readonly LineId[] | undefined;
}

export interface TextModelHistoryLimit {
	readonly transactions?: number;
	readonly textUnits?: number;
}

/** Schedules cancellable TextModel maintenance outside the edit transaction. */
export type TextModelMaintenanceScheduler = (callback: () => void) => IDisposable;

/** Controls how one TextModel runs optional storage maintenance. */
export interface TextModelMaintenanceOptions {
	readonly schedule: TextModelMaintenanceScheduler;
}

export interface TextModelOptions {
	readonly resource?: URI;
	readonly languageId?: string;
	readonly isForSimpleWidget?: boolean;
	readonly historyLimit?: TextModelHistoryLimit;
	/** Product-owned scheduling for non-semantic piece-tree maintenance. */
	readonly maintenance?: TextModelMaintenanceOptions;
	/** Schema-backed blocks used by document profiles. */
	readonly blocks?: TextModelBlockInitialization;
	/** Stable identities restored by a rich-document codec. Plain text codecs omit this. */
	readonly lineIds?: readonly LineId[];
	/** Document-level metadata such as a code file's languageId. */
	readonly metadata?: LineSemanticAttributes;
	/** Identity source for logical lines created by text edits. */
	readonly lineIdGenerator?: () => LineId;
	readonly tabSize?: number;
	readonly indentSize?: number | 'tabSize';
	readonly insertSpaces?: boolean;
	readonly defaultEOL?: DefaultEndOfLine;
	readonly trimAutoWhitespace?: boolean;
	readonly largeFileOptimizations?: boolean;
	readonly bracketPairColorizationOptions?: BracketPairColorizationOptions;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly tokenization?: TokenizationTextModelPartOptions;
}

export interface TextModelBlockInitialization extends TextModelBlockOptions {
	readonly schema: DocumentSchema;
	readonly document?: DocumentNode;
}

export interface TextEditOptions {
	readonly historyGroup?: UndoRedoGroup;
	readonly historyMergeMode?: TextEditHistoryMergeMode;
	readonly editSource?: TextModelEditSource;
}

export interface TextModelUndoRedoSnapshot {
	readonly contentSHA1: string;
	readonly contentLength: number;
	readonly eol: EndOfLineSequence;
	readonly bom: string;
	readonly history: TextModelHistorySnapshot;
	readonly nextTransactionId: number;
	readonly alternativeVersionId: number;
}

const DEFAULT_HISTORY_TRANSACTIONS = 1_000;
const DEFAULT_HISTORY_TEXT_UNITS = 16 * 1_024 * 1_024;
const LONG_LINE_BOUNDARY = 10_000;
const LINE_HEIGHT_CEILING = 300;
let MODEL_ID = 0;

/**
 * Ash's canonical mutable text document.
 *
 * The model owns text normalized to one document EOL sequence, versioning, atomic non-overlapping edit
 * transactions, transaction-level undo/redo, and generic tracked ranges.
 * Logical line identity and rich semantic stores remain part of this same model and version.
 * URI and language are part of the model identity. Persistence and presentation
 * remain outside the model.
 */
export class TextModel implements ITextModel {
	private readonly disposables = new DisposableStore();
	private disposed = false;
	private disposing = false;
	private readonly willDisposeEmitter = this._register(new Emitter<void>());
	private readonly changeEmitter = this._register(new Emitter<TextModelChange>());
	private readonly languageEmitter = this._register(new Emitter<IModelLanguageChangedEvent>());
	private readonly optionsEmitter = this._register(new Emitter<IModelOptionsChangedEvent>());
	private readonly decorationsEmitter = this._register(new Emitter<IModelDecorationsChangedEvent>());
	private readonly languageConfigurationEmitter = this._register(new Emitter<IModelLanguageConfigurationChangedEvent>());
	private readonly tokensEmitter = this._register(new Emitter<IModelTokensChangedEvent>());
	private readonly lineHeightEmitter = this._register(new Emitter<ModelLineHeightChangedEvent>());
	private readonly fontEmitter = this._register(new Emitter<ModelFontChangedEvent>());
	private readonly attachedEmitter = this._register(new Emitter<void>());
	private readonly attachedViews = new Set<IAttachedView>();
	private readonly viewModels = new Set<IViewModel>();
	private readonly languageSelection = this._register(new MutableDisposable<IDisposable>());
	private readonly trackedRanges = this._register(new TrackedRangeCollection(
		offset => this.positionAt(offset),
	));
	private readonly modelTrackedRanges = new Map<string, TrackedRange>();
	private nextTrackedRangeId = 1;
	private readonly modelDecorations = new Map<string, ModelDecorationEntry>();
	private nextDecorationId = 1;
	private readonly history: TextModelHistory;
	private readonly maintenance: TextModelMaintenanceOptions | undefined;
	private readonly pendingMaintenance = this._register(new MutableDisposable<IDisposable>());
	private buffer: ITextBuffer;
	private readonly blockState: TextModelBlockState | undefined;
	private readonly lineIdGenerator: () => LineId;
	private readonly issuedLineIds = new Set<LineId>();
	private nextGeneratedLineIdentity = 1;
	private readonly lineMetadata: LineSemanticAttributes;
	private plainLineIds: readonly LineId[] | undefined;
	private plainLineSnapshot: LineDocumentSnapshot | undefined;
	readonly largeFile: TextModelLargeFilePolicy;
	private nextTransactionId = 1;
	private _version = 1;
	private _alternativeVersion = 1;
	private languageId: string;
	private modelOptionsValue: TextModelResolvedOptions;

	readonly id: string;
	readonly uri: URI;
	readonly isForSimpleWidget: boolean;
	private readonly _bracketPairs: BracketPairsTextModelPart;
	private readonly bracketDecorations: DecorationProvider;
	get bracketPairs(): IBracketPairsTextModelPart { return this._bracketPairs; }
	readonly guides: GuidesTextModelPart;
	readonly tokenization: TokenizationTextModelPart;
	readonly diagnostics: ModelLanguageDiagnostics;

	readonly onDidChangeContent: Event<TextModelChange> = this.changeEmitter.event;
	readonly onDidChangeLanguage: Event<IModelLanguageChangedEvent> = this.languageEmitter.event;
	readonly onDidChangeLanguageConfiguration: Event<IModelLanguageConfigurationChangedEvent> = this.languageConfigurationEmitter.event;
	readonly onDidChangeTokens: Event<IModelTokensChangedEvent> = this.tokensEmitter.event;
	readonly onDidChangeLineHeight: Event<ModelLineHeightChangedEvent> = this.lineHeightEmitter.event;
	readonly onDidChangeFont: Event<ModelFontChangedEvent> = this.fontEmitter.event;
	readonly onDidChangeOptions: Event<IModelOptionsChangedEvent> = this.optionsEmitter.event;
	readonly onDidChangeDecorations: Event<IModelDecorationsChangedEvent> = this.decorationsEmitter.event;
	readonly onDidChangeAttached: Event<void> = this.attachedEmitter.event;
	/** Fires once so registries can release model identity before teardown completes. */
	readonly onWillDispose: Event<void> = this.willDisposeEmitter.event;

	constructor(initialText = "", options: TextModelOptions = {}) {
		MODEL_ID += 1;
		this.id = `$model${MODEL_ID}`;
		this.uri = options.resource ?? URI.parse(`inmemory://model/${MODEL_ID}`);
		this.languageId = requireLanguageId(options.languageId ?? 'plaintext');
		this.modelOptionsValue = new TextModelResolvedOptions({
			tabSize: options.tabSize ?? EDITOR_MODEL_DEFAULTS.tabSize,
			indentSize: options.indentSize ?? EDITOR_MODEL_DEFAULTS.indentSize,
			insertSpaces: options.insertSpaces ?? EDITOR_MODEL_DEFAULTS.insertSpaces,
			defaultEOL: options.defaultEOL ?? DefaultEndOfLine.LF,
			trimAutoWhitespace: options.trimAutoWhitespace ?? EDITOR_MODEL_DEFAULTS.trimAutoWhitespace,
			bracketPairColorizationOptions: options.bracketPairColorizationOptions ?? EDITOR_MODEL_DEFAULTS.bracketPairColorizationOptions,
		});
		this.isForSimpleWidget = options.isForSimpleWidget ?? false;
		const historyTransactionLimit = readHistoryLimit(
			options.historyLimit?.transactions,
			DEFAULT_HISTORY_TRANSACTIONS,
			"historyLimit.transactions",
		);
		const historyTextUnitLimit = readHistoryLimit(
			options.historyLimit?.textUnits,
			DEFAULT_HISTORY_TEXT_UNITS,
			"historyLimit.textUnits",
		);
		this.maintenance = readMaintenanceOptions(options.maintenance);
		this.history = new TextModelHistory(
			historyTransactionLimit,
			historyTextUnitLimit,
		);
		if (options.blocks && options.lineIds) throw new TypeError("Schema-backed TextModel line identities come from the document codec");
		if (options.lineIdGenerator !== undefined && typeof options.lineIdGenerator !== "function") {
			throw new TypeError("TextModel lineIdGenerator must be a function");
		}
		this.lineIdGenerator = options.lineIdGenerator ?? (() => `line:${this.nextGeneratedLineIdentity++}`);
		const blockDocument = options.blocks?.document ?? options.blocks?.schema.createDocument();
		const blockSnapshot = blockDocument && options.blocks ? projectDocumentToLines(options.blocks.schema, blockDocument) : undefined;
		const initialValue = blockSnapshot?.getText() ?? initialText;
		this.buffer = createPieceTreeTextBuffer(initialValue, this.modelOptionsValue.defaultEOL);
		if (!options.blocks) {
			this.plainLineIds = this.initializeLineIds(options.lineIds);
			this.plainLineSnapshot = this.createPlainLineSnapshot(options.metadata);
			this.lineMetadata = this.plainLineSnapshot.metadata;
		} else {
			this.lineMetadata = Object.freeze({});
		}
		this.largeFile = classifyTextModelSize(
			this.buffer.getLength(),
			this.buffer.getLineCount(),
			options.largeFileOptimizations ?? EDITOR_MODEL_DEFAULTS.largeFileOptimizations,
		);
		this.blockState = options.blocks && blockDocument ? this._register(new TextModelBlockState(
			options.blocks.schema,
			blockDocument,
			options.blocks,
			{
				getVersion: () => this._version,
				commitText: text => this.commitBlockText(text),
				publishTextChange: change => this.publishTextChange(change),
			},
		)) : undefined;
		const languageConfigurationService = options.languageConfigurationService;
		const resolveLanguageConfiguration = languageConfigurationService
			? (languageId: string) => languageConfigurationService.getLanguageConfiguration(languageId)
			: (languageId: string) => new ResolvedLanguageConfiguration(languageId, {});
		this._bracketPairs = this._register(new BracketPairsTextModelPart(this, resolveLanguageConfiguration));
		const bracketDecorations = this._register(new ColorizedBracketPairsDecorationProvider(this));
		this.bracketDecorations = bracketDecorations;
		this._register(bracketDecorations.onDidChange(() => this.emitDecorationsChanged([])));
		this.guides = this._register(new GuidesTextModelPart(this, resolveLanguageConfiguration));
		this.tokenization = this._register(new TokenizationTextModelPart(this, options.tokenization));
		this.diagnostics = this._register(new ModelLanguageDiagnostics(this, options.tokenization?.syntaxProviderRegistry, options.languageConfigurationService?.onDidChange));
		if (languageConfigurationService) this._register(languageConfigurationService.onDidChange(event => {
			this._bracketPairs.handleLanguageConfigurationServiceChange(event);
			if (event.affects(this.languageId)) this.languageConfigurationEmitter.fire({});
		}));
		this._register(this.onDidChangeLanguage(event => this._bracketPairs.handleDidChangeLanguage(event)));
		this._register(this.onDidChangeOptions(event => this._bracketPairs.handleDidChangeOptions(event)));
		this._register(this.tokenization.onDidChange(() => {
			const event: IModelTokensChangedEvent = {
				semanticTokensApplied: false,
				ranges: [{ fromLineNumber: 1, toLineNumber: this.getLineCount() }],
			};
			this._bracketPairs.handleDidChangeTokens(event);
			this._bracketPairs.handleDidChangeBackgroundTokenizationState();
			this.tokensEmitter.fire(event);
		}));
		this._register(toDisposable(() => {
			this.history.dispose();
			this.buffer.dispose();
		}));
		this._register(this.onDidChangeContent(() => {
			if (this.modelDecorations.size > 0) this.emitDecorationsChanged(this.modelDecorations.values());
		}));
	}

	/** Creates one TextModel from schema-backed document content. */
	static create(schema: DocumentSchema, document = schema.createDocument(), options: TextModelBlockOptions = {}): TextModel {
		return new TextModel("", { blocks: { ...options, schema, document } });
	}

	/** Immutable line-first content snapshot at the current model version. */
	get lineDocument(): LineDocumentSnapshot {
		this.assertNotDisposed();
		return this.blockState?.snapshot ?? this.requirePlainLineSnapshot();
	}

	getLineId(lineIndex: number): LineId {
		this.assertNotDisposed();
		if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) throw new RangeError("Line index is outside the TextModel");
		const line = this.lineDocument.lines.at(lineIndex);
		if (!line) throw new RangeError("Line index is outside the TextModel");
		return line.id;
	}

	getLineIndex(lineId: LineId): number {
		this.assertNotDisposed();
		const lineIndex = this.lineDocument.lines.indexOf(lineId);
		if (lineIndex < 0) throw new RangeError(`Line '${lineId}' does not exist in the TextModel`);
		return lineIndex;
	}

	linePointAt(position: Position): LinePoint {
		this.assertNotDisposed();
		this.offsetAt(position);
		return linePoint(this.getLineId(position.lineNumber - 1), position.column - 1);
	}

	textPositionAt(point: LinePoint): Position {
		this.assertNotDisposed();
		const lineIndex = this.getLineIndex(point.lineId);
		if (!Number.isSafeInteger(point.offset) || point.offset < 0 || point.offset > this.buffer.getLineLength(lineIndex + 1)) {
			throw new RangeError("Line point offset is outside the TextModel");
		}
		return new Position((lineIndex) + 1, (point.offset) + 1);
	}

	get schema(): DocumentSchema {
		return this.requireBlockState().schema;
	}

	get document(): DocumentNode {
		return this.requireBlockState().document;
	}

	get selection(): DocumentSelection | undefined {
		return this.requireBlockState().selection;
	}

	get storedMarks(): readonly DocumentMark[] | undefined {
		return this.requireBlockState().storedMarks;
	}

	get onDidChangeBlocks(): Event<TextModelBlockChange> {
		return this.requireBlockState().onDidChange;
	}

	get onDidChangeSelection(): Event<DocumentSelection | undefined> {
		return this.requireBlockState().onDidChangeSelection;
	}

	get onDidChangeStoredMarks(): Event<readonly DocumentMark[] | undefined> {
		return this.requireBlockState().onDidChangeStoredMarks;
	}

	get canUndoBlocks(): boolean {
		return this.requireBlockState().canUndo;
	}

	get canRedoBlocks(): boolean {
		return this.requireBlockState().canRedo;
	}

	dispatch(transaction: DocumentTransaction): TextModelBlockChange | undefined {
		return this.requireBlockState().dispatch(transaction);
	}

	dispatchRemote(transaction: DocumentTransaction, historyPolicy: TextModelRemoteHistoryPolicy = TextModelRemoteHistoryPolicy.Clear): TextModelBlockChange | undefined {
		return this.requireBlockState().dispatchRemote(transaction, historyPolicy);
	}

	rebaseHistory(mapper: (entries: DocumentHistoryEntries) => DocumentHistoryEntries): void {
		this.requireBlockState().rebaseHistory(mapper);
	}

	undoBlocks(): TextModelBlockChange | undefined {
		return this.requireBlockState().undo();
	}

	redoBlocks(): TextModelBlockChange | undefined {
		return this.requireBlockState().redo();
	}

	setSelection(selection: DocumentSelection | undefined): void {
		this.requireBlockState().setSelection(selection);
	}

	setStoredMarks(marks: readonly DocumentMark[] | undefined): void {
		this.requireBlockState().setStoredMarks(marks);
	}

	resetBlocks(document: DocumentNode): TextModelBlockChange | undefined {
		return this.requireBlockState().reset(document);
	}

	getPluginState<T>(key: DocumentPluginKey<T>): T | undefined {
		return this.requireBlockState().getPluginState(key);
	}

	getPluginDecorations(): readonly TextModelPluginDecorationSource[] {
		return this.requireBlockState().getPluginDecorations();
	}

	get version(): number {
		this.assertNotDisposed();
		return this._version;
	}

	getLanguageId(): string {
		this.assertNotDisposed();
		return this.languageId;
	}

	setLanguage(languageId: string, source?: string): void;
	setLanguage(languageSelection: ILanguageSelection, source?: string): void;
	setLanguage(languageIdOrSelection: string | ILanguageSelection, source = 'api'): void {
		this.assertNotDisposed();
		if (typeof languageIdOrSelection !== 'string') {
			const selection = languageIdOrSelection;
			this.languageSelection.value = selection.onDidChange(() => this.setLanguageValue(selection.languageId, source));
			this.setLanguageValue(selection.languageId, source);
			return;
		}
		this.languageSelection.clear();
		this.setLanguageValue(languageIdOrSelection, source);
	}

	private setLanguageValue(languageId: string, source: string): void {
		const nextLanguage = requireLanguageId(languageId);
		const oldLanguage = this.languageId;
		if (oldLanguage === nextLanguage) return;
		this.languageId = nextLanguage;
		this.languageEmitter.fire(Object.freeze({ oldLanguage, newLanguage: nextLanguage, source }));
	}

	get lineCount(): number {
		this.assertNotDisposed();
		return this.buffer.getLineCount();
	}

	get length(): number {
		this.assertNotDisposed();
		return this.buffer.getLength();
	}

	/** The document length in the same line/column algebra used by core edits. */
	get textLength(): TextLength {
		this.assertNotDisposed();
		return new TextLength(this.buffer.getLineCount() - 1, this.buffer.getLineLength(this.buffer.getLineCount()));
	}

	canUndo(): boolean {
		this.assertNotDisposed();
		return this.history.canUndo;
	}

	canRedo(): boolean {
		this.assertNotDisposed();
		return this.history.canRedo;
	}

	/** Captures model-local history for a resolver that is about to release this model instance. */
	createUndoRedoSnapshot(): TextModelUndoRedoSnapshot | undefined {
		if (this.isDisposed() && !this.disposing) throw new ReferenceError('TextModel is already disposed');
		const history = this.history.createSnapshot();
		if (!history || history.undo.length === 0 && history.redo.length === 0) return undefined;
		const text = this.buffer.createSnapshot().getText();
		const sha1 = new StringSHA1();
		sha1.update(text);
		return Object.freeze({
			contentSHA1: sha1.digest(),
			contentLength: text.length,
			eol: this.buffer.getEOL() === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF,
			bom: this.buffer.getBOM(),
			history,
			nextTransactionId: this.nextTransactionId,
			alternativeVersionId: this._alternativeVersion,
		});
	}

	/** Restores history only into a newly created model with the exact captured text. */
	restoreUndoRedoSnapshot(snapshot: TextModelUndoRedoSnapshot): boolean {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		if (this._version !== 1 || this.canUndo() || this.canRedo()) throw new Error('Undo and redo history can only be restored into a new TextModel');
		const sha1 = new StringSHA1();
		sha1.update(this.getText());
		if (snapshot.contentSHA1 !== sha1.digest() || snapshot.eol !== this.getEndOfLineSequence() || snapshot.bom !== this.buffer.getBOM()) return false;
		this.history.restoreSnapshot(snapshot.history);
		this.nextTransactionId = Math.max(this.nextTransactionId, snapshot.nextTransactionId);
		this._alternativeVersion = snapshot.alternativeVersionId;
		return true;
	}

	getText(): string {
		return this.getValue();
	}

	onBeforeAttached(): IAttachedView {
		this.assertNotDisposed();
		const model = this;
		const view: IAttachedView = Object.freeze({
			setVisibleLines(visibleLines: { startLineNumber: number; endLineNumber: number }[], stabilized: boolean): void {
				if (!model.attachedViews.has(view)) throw new ReferenceError('Text model view is not attached');
				for (const range of visibleLines) {
					if (!Number.isSafeInteger(range.startLineNumber) || !Number.isSafeInteger(range.endLineNumber)
						|| range.startLineNumber < 1 || range.endLineNumber < range.startLineNumber || range.endLineNumber > model.getLineCount()) {
						throw new RangeError('Attached view visible lines must be valid model line ranges');
					}
				}
				if (stabilized) model.buffer.maintainIfNeeded();
			},
		});
		const wasDetached = this.attachedViews.size === 0;
		this.attachedViews.add(view);
		if (wasDetached) this.attachedEmitter.fire();
		return view;
	}

	onBeforeDetached(view: IAttachedView): void {
		if (!this.attachedViews.delete(view)) throw new ReferenceError('Text model view is not attached');
		if (this.attachedViews.size === 0) this.attachedEmitter.fire();
	}

	isAttachedToEditor(): boolean {
		return this.attachedViews.size > 0;
	}

	getAttachedEditorCount(): number {
		return this.attachedViews.size;
	}

	registerViewModel(viewModel: IViewModel): void {
		this.assertNotDisposed();
		if (this.viewModels.has(viewModel)) throw new ReferenceError('View model is already registered');
		this.viewModels.add(viewModel);
	}

	unregisterViewModel(viewModel: IViewModel): void {
		if (!this.viewModels.delete(viewModel)) throw new ReferenceError('View model is not registered');
	}

	equalsTextBuffer(other: ITextBuffer): boolean {
		this.assertNotDisposed();
		return this.buffer.equals(other);
	}

	getTextBuffer(): ITextBuffer {
		this.assertNotDisposed();
		return this.buffer;
	}

	getVersionId(): number {
		return this.version;
	}

	getOptions(): TextModelResolvedOptions {
		this.assertNotDisposed();
		return this.modelOptionsValue;
	}

	getFormattingOptions(): languages.FormattingOptions {
		const options = this.getOptions();
		return { tabSize: options.indentSize, insertSpaces: options.insertSpaces };
	}

	getAlternativeVersionId(): number {
		this.assertNotDisposed();
		return this._alternativeVersion;
	}

	mightContainRTL(): boolean {
		this.assertNotDisposed();
		return this.buffer.mightContainRTL();
	}

	mightContainUnusualLineTerminators(): boolean {
		this.assertNotDisposed();
		return this.buffer.mightContainUnusualLineTerminators();
	}

	removeUnusualLineTerminators(_selections?: Selection[]): void {
		this.assertNotDisposed();
		const matches = this.findMatches('[\u2028\u2029]', false, true, false, null, false, 100_000);
		this.buffer.resetMightContainUnusualLineTerminators();
		this.applyOperations(matches.map(match => ({ range: match.range, text: null })));
	}

	mightContainNonBasicASCII(): boolean {
		this.assertNotDisposed();
		return this.buffer.mightContainNonBasicASCII();
	}

	isTooLargeForSyncing(): boolean {
		return this.largeFile.tooLargeForSynchronization;
	}

	isTooLargeForTokenization(): boolean {
		return this.largeFile.tooLargeForTokenization;
	}

	isTooLargeForHeapOperation(): boolean {
		return this.largeFile.tooLargeForHeapOperation;
	}

	isDominatedByLongLines(): boolean {
		this.assertNotDisposed();
		if (this.isTooLargeForTokenization()) return false;
		let smallLineCharacterCount = 0;
		let longLineCharacterCount = 0;
		for (let lineNumber = 1; lineNumber <= this.buffer.getLineCount(); lineNumber++) {
			const lineLength = this.buffer.getLineLength(lineNumber);
			if (lineLength >= LONG_LINE_BOUNDARY) longLineCharacterCount += lineLength;
			else smallLineCharacterCount += lineLength;
		}
		return longLineCharacterCount > smallLineCharacterCount;
	}

	findMatches(
		searchString: string,
		searchScope: boolean | IRange | IRange[],
		isRegex: boolean,
		matchCase: boolean,
		wordSeparators: string | null,
		captureMatches: boolean,
		limitResultCount = 999,
	): FindMatch[] {
		this.assertNotDisposed();
		const query = createSearchQuery(searchString, isRegex, matchCase, wordSeparators);
		const scopes = typeof searchScope === 'boolean'
			? [this.getFullModelRange()]
			: (Array.isArray(searchScope) ? searchScope : [searchScope]).map(scope => this.validateRange(scope));
		const matches: FindMatch[] = [];
		for (const scope of mergeSearchScopes(scopes)) {
			const remaining = limitResultCount - matches.length;
			if (remaining <= 0) break;
			for (const match of findTextMatches(this, query, { range: scope, resultLimit: remaining })) {
				matches.push(toFindMatch(match, captureMatches));
			}
		}
		return matches;
	}

	findNextMatch(
		searchString: string,
		searchStart: IPosition,
		isRegex: boolean,
		matchCase: boolean,
		wordSeparators: string | null,
		captureMatches: boolean,
	): FindMatch | null {
		this.assertNotDisposed();
		const match = findNextTextMatch(
			this,
			createSearchQuery(searchString, isRegex, matchCase, wordSeparators),
			this.validatePosition(searchStart),
			true,
		);
		return match ? toFindMatch(match, captureMatches) : null;
	}

	findPreviousMatch(
		searchString: string,
		searchStart: IPosition,
		isRegex: boolean,
		matchCase: boolean,
		wordSeparators: string | null,
		captureMatches: boolean,
	): FindMatch | null {
		this.assertNotDisposed();
		const startOffset = this.getOffsetAt(this.validatePosition(searchStart));
		const matches = findTextMatches(
			this,
			createSearchQuery(searchString, isRegex, matchCase, wordSeparators),
			{ resultLimit: 100_000 },
		);
		if (matches.length === 0) return null;
		let previous: TextSearchMatch | undefined;
		for (const match of matches) {
			if (this.getOffsetAt(match.range.getStartPosition()) >= startOffset) break;
			previous = match;
		}
		return toFindMatch(previous ?? matches[matches.length - 1]!, captureMatches);
	}

	setValue(newValue: string | ITextSnapshot): void {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		if (typeof newValue === 'string') {
			this.reset(newValue);
			return;
		}
		if (!isITextSnapshot(newValue)) throw new TypeError('TextModel value must be a string or ITextSnapshot');
		const chunks: string[] = [];
		for (let chunk = newValue.read(); chunk !== null; chunk = newValue.read()) chunks.push(chunk);
		this.reset(chunks.join(''));
	}

	getValue(eol = EndOfLinePreference.TextDefined, preserveBOM = false): string {
		this.assertNotDisposed();
		if (this.isTooLargeForHeapOperation()) throw new BugIndicatingError('Operation would exceed heap memory limits');
		const value = this.getValueInRange(this.getFullModelRange(), eol);
		return preserveBOM ? this.buffer.getBOM() + value : value;
	}

	createSnapshot(preserveBOM = false): ITextSnapshot {
		this.assertNotDisposed();
		const snapshot = this.buffer.createSnapshot(preserveBOM);
		let offset = 0;
		return {
			read: (): string | null => {
				if (offset >= snapshot.length) return null;
				const endOffset = Math.min(snapshot.length, offset + 64 * 1_024);
				const value = snapshot.getTextBetweenOffsets(offset, endOffset);
				offset = endOffset;
				return value;
			},
		};
	}

	getValueLength(eol = EndOfLinePreference.TextDefined, preserveBOM = false): number {
		return this.getValueLengthInRange(this.getFullModelRange(), eol) + (preserveBOM ? this.buffer.getBOM().length : 0);
	}

	createVersionedSnapshot(): TextSnapshot {
		this.assertNotDisposed();
		const version = this._version;
		const snapshot = this.buffer.createSnapshot();
		return Object.freeze({
			version,
			length: snapshot.length,
			lineCount: snapshot.lineCount,
			getText: () => snapshot.getText(),
			getTextBetweenOffsets: (
				startOffset: number,
				endOffset: number,
			) => snapshot.getTextBetweenOffsets(startOffset, endOffset),
		});
	}

	getTextInRange(range: Range): string {
		this.assertNotDisposed();
		return this.buffer.getValueInRange(range);
	}

	getValueInRange(range: IRange, eol = EndOfLinePreference.TextDefined): string {
		const value = this.getTextInRange(Range.lift(range));
		if (eol === EndOfLinePreference.TextDefined) return value;
		const lineFeedValue = value.replace(/\r\n|\r/g, '\n');
		return eol === EndOfLinePreference.CRLF ? lineFeedValue.replace(/\n/g, '\r\n') : lineFeedValue;
	}

	getValueLengthInRange(range: IRange, eol = EndOfLinePreference.TextDefined): number {
		return this.getValueInRange(range, eol).length;
	}

	getCharacterCountInRange(range: IRange, eol = EndOfLinePreference.TextDefined): number {
		return [...this.getValueInRange(range, eol)].length;
	}

	modifyPosition(position: IPosition, offset: number): Position {
		const candidate = this.getOffsetAt(position) + offset;
		return this.getPositionAt(Math.min(this.length, Math.max(0, candidate)));
	}

	getLineCount(): number {
		return this.lineCount;
	}

	getLineContent(lineNumber: number): string {
		this.assertNotDisposed();
		return this.buffer.getLineContent(lineNumber);
	}

	getLineLength(lineNumber: number): number {
		this.assertNotDisposed();
		return this.buffer.getLineLength(lineNumber);
	}

	getLinesContent(): string[] {
		this.assertNotDisposed();
		if (this.isTooLargeForHeapOperation()) throw new BugIndicatingError('Operation would exceed heap memory limits');
		return this.buffer.getLinesContent();
	}

	getEOL(): string {
		this.assertNotDisposed();
		return this.buffer.getEOL();
	}

	getEndOfLineSequence(): EndOfLineSequence {
		this.assertNotDisposed();
		return this.buffer.getEOL() === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF;
	}

	setEOL(eol: EndOfLineSequence): void {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		const result = this.commitOffsetEdits([], {
			reason: TextModelChangeReason.EOL,
			eol: requireEndOfLineSequence(eol),
			editSource: EditSources.eolChange(),
		});
		if (result) this.publishTextChange(result.change);
	}

	pushEOL(eol: EndOfLineSequence, reason?: TextModelEditSource): void {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		const targetEOL = requireEndOfLineSequence(eol);
		const previousEOL = this.getEndOfLineSequence();
		if (targetEOL === previousEOL) return;
		const coalescingEntry = this.history.findUndoEntry(undefined, () => true);
		const previousAlternativeVersionId = this._alternativeVersion;
		const result = this.commitOffsetEdits([], {
			reason: TextModelChangeReason.EOL,
			eol: targetEOL,
			editSource: reason ?? EditSources.eolChange(),
			transactionId: coalescingEntry?.transactionId,
		});
		if (!result) return;
		this.history.prepareForEdit(undefined);
		this.history.clearRedo();
		if (coalescingEntry) {
			const textChanges = compressConsecutiveTextChanges([...coalescingEntry.textChanges], result.textChanges);
			this.history.replaceUndoEntry(coalescingEntry, inverseEditsFromTextChanges(textChanges), textChanges, null);
		} else {
			this.history.pushUndo(
				[],
				result.change.transactionId,
				previousAlternativeVersionId,
				targetEOL,
				previousEOL,
				undefined,
				undefined,
				null,
				null,
				result.textChanges,
			);
		}
		this.publishTextChange(result.change);
	}

	getLineMinColumn(_lineNumber: number): number {
		this.assertNotDisposed();
		return 1;
	}

	getLineMaxColumn(lineNumber: number): number {
		return this.getLineLength(lineNumber) + 1;
	}

	getLineFirstNonWhitespaceColumn(lineNumber: number): number {
		const index = this.getLineContent(lineNumber).search(/\S/u);
		return index < 0 ? 0 : index + 1;
	}

	getLineLastNonWhitespaceColumn(lineNumber: number): number {
		const content = this.getLineContent(lineNumber);
		for (let index = content.length - 1; index >= 0; index -= 1) {
			if (/\S/u.test(content[index])) return index + 2;
		}
		return 0;
	}

	getFullModelRange(): Range {
		return new Range(1, 1, this.lineCount, this.getLineMaxColumn(this.lineCount));
	}

	offsetAt(position: Position): number {
		this.assertNotDisposed();
		return this.buffer.getOffsetAt(position.lineNumber, position.column);
	}

	getOffsetAt(position: IPosition): number {
		this.assertNotDisposed();
		const bounded = this.clampPosition(position);
		return this.buffer.getOffsetAt(bounded.lineNumber, bounded.column);
	}

	positionAt(offset: number): Position {
		this.assertNotDisposed();
		return this.buffer.getPositionAt(offset);
	}

	getPositionAt(offset: number): Position {
		this.assertNotDisposed();
		const normalized = typeof offset === 'number' && !Number.isNaN(offset) ? Math.floor(offset) : 0;
		return this.buffer.getPositionAt(Math.min(Math.max(normalized, 0), this.length));
	}

	getRangeAt(offset: number, length: number): Range {
		this.assertNotDisposed();
		return this.buffer.getRangeAt(offset, length);
	}

	validatePosition(position: IPosition): Position {
		this.assertNotDisposed();
		const bounded = this.clampPosition(position);
		return this.isInsideSurrogatePair(bounded)
			? new Position(bounded.lineNumber, bounded.column - 1)
			: bounded;
	}

	validateRange(range: IRange): Range {
		this.assertNotDisposed();
		const lifted = Range.lift(range);
		const start = this.clampPosition(lifted.getStartPosition());
		const end = this.clampPosition(lifted.getEndPosition());
		const startInside = this.isInsideSurrogatePair(start);
		const endInside = this.isInsideSurrogatePair(end);
		if (start.equals(end) && startInside) {
			return new Range(start.lineNumber, start.column - 1, end.lineNumber, end.column - 1);
		}
		return new Range(
			start.lineNumber,
			start.column - (startInside ? 1 : 0),
			end.lineNumber,
			end.column + (endInside ? 1 : 0),
		);
	}

	isValidRange(range: IRange): boolean {
		this.assertNotDisposed();
		if (!Number.isSafeInteger(range.startLineNumber) || !Number.isSafeInteger(range.startColumn)
			|| !Number.isSafeInteger(range.endLineNumber) || !Number.isSafeInteger(range.endColumn)) return false;
		if (!Position.isBeforeOrEqual(
			{ lineNumber: range.startLineNumber, column: range.startColumn },
			{ lineNumber: range.endLineNumber, column: range.endColumn },
		)) return false;
		const lifted = Range.lift(range);
		if (lifted.startLineNumber < 1 || lifted.endLineNumber > this.lineCount) return false;
		if (lifted.startColumn < 1 || lifted.endColumn < 1) return false;
		if (lifted.startColumn > this.getLineMaxColumn(lifted.startLineNumber)) return false;
		if (lifted.endColumn > this.getLineMaxColumn(lifted.endLineNumber)) return false;
		return !this.isInsideSurrogatePair(lifted.getStartPosition()) && !this.isInsideSurrogatePair(lifted.getEndPosition());
	}

	private clampPosition(position: IPosition): Position {
		const rawLine = typeof position.lineNumber === 'number' && !Number.isNaN(position.lineNumber) ? Math.floor(position.lineNumber) : 1;
		const rawColumn = typeof position.column === 'number' && !Number.isNaN(position.column) ? Math.floor(position.column) : 1;
		if (rawLine < 1) return new Position(1, 1);
		if (rawLine > this.lineCount) return new Position(this.lineCount, this.getLineMaxColumn(this.lineCount));
		return new Position(rawLine, Math.min(Math.max(rawColumn, 1), this.getLineMaxColumn(rawLine)));
	}

	private isInsideSurrogatePair(position: IPosition): boolean {
		if (position.column <= 1 || position.column >= this.getLineMaxColumn(position.lineNumber)) return false;
		return strings.isHighSurrogate(this.buffer.getLineCharCode(position.lineNumber, position.column - 2));
	}

	getLanguageIdAtPosition(lineNumber: number, column: number): string {
		return this.tokenization.getLanguageIdAtPosition(lineNumber, column);
	}

	getWordAtPosition(position: IPosition): IWordAtPosition | null {
		this.assertNotDisposed();
		const validPosition = this.validatePosition(position);
		const word = getWordAtText(validPosition.column, DEFAULT_WORD_REGEXP, this.getLineContent(validPosition.lineNumber), 0);
		return word && word.startColumn <= position.column && position.column <= word.endColumn ? word : null;
	}

	getWordUntilPosition(position: IPosition): IWordAtPosition {
		const validPosition = this.validatePosition(position);
		const word = this.getWordAtPosition(validPosition);
		if (!word) {
			return { word: '', startColumn: validPosition.column, endColumn: validPosition.column };
		}
		return {
			word: word.word.slice(0, validPosition.column - word.startColumn),
			startColumn: word.startColumn,
			endColumn: validPosition.column,
		};
	}

	normalizePosition(position: Position, _affinity: PositionAffinity): Position {
		return position;
	}

	getLineIndentColumn(lineNumber: number): number {
		const firstNonWhitespaceColumn = this.getLineFirstNonWhitespaceColumn(lineNumber);
		return firstNonWhitespaceColumn === 0 ? this.getLineMaxColumn(lineNumber) : firstNonWhitespaceColumn;
	}

	normalizeIndentation(value: string): string {
		const options = this.getOptions();
		return normalizeIndentation(value, options.indentSize, options.insertSpaces);
	}

	updateOptions(newOptions: ITextModelUpdateOptions): void {
		this.assertNotDisposed();
		const current = this.modelOptionsValue;
		const next = new TextModelResolvedOptions({
			tabSize: newOptions.tabSize ?? current.tabSize,
			indentSize: newOptions.indentSize ?? current.originalIndentSize,
			insertSpaces: newOptions.insertSpaces ?? current.insertSpaces,
			defaultEOL: current.defaultEOL,
			trimAutoWhitespace: newOptions.trimAutoWhitespace ?? current.trimAutoWhitespace,
			bracketPairColorizationOptions: newOptions.bracketColorizationOptions ?? current.bracketPairColorizationOptions,
		});
		if (current.equals(next)) return;
		this.modelOptionsValue = next;
		this.optionsEmitter.fire(current.createChangeEvent(next));
	}

	detectIndentation(defaultInsertSpaces: boolean, defaultTabSize: number): void {
		this.assertNotDisposed();
		const guessedIndentation = guessIndentation(this.buffer, defaultTabSize, defaultInsertSpaces);
		this.updateOptions({
			insertSpaces: guessedIndentation.insertSpaces,
			tabSize: guessedIndentation.tabSize,
			indentSize: guessedIndentation.tabSize,
		});
	}

	trackRange(
		range: Range,
		stickiness: TrackedRangeStickiness,
	): TrackedRange {
		this.assertNotDisposed();
		return this.trackedRanges.add(
			this.offsetAt(range.getStartPosition()),
			this.offsetAt(range.getEndPosition()),
			stickiness,
		);
	}

	_getTrackedRange(id: string): Range | null {
		this.assertNotDisposed();
		return this.modelTrackedRanges.get(id)?.range ?? null;
	}

	_setTrackedRange(id: string | null, newRange: null, newStickiness: TrackedRangeStickiness): null;
	_setTrackedRange(id: string | null, newRange: Range, newStickiness: TrackedRangeStickiness): string;
	_setTrackedRange(id: string | null, newRange: Range | null, newStickiness: TrackedRangeStickiness): string | null {
		this.assertNotDisposed();
		if (id !== null) {
			const existing = this.modelTrackedRanges.get(id);
			if (!existing) throw new RangeError(`Unknown tracked range '${id}'`);
			existing.dispose();
			this.modelTrackedRanges.delete(id);
		}
		if (newRange === null) return null;
		const nextId = id ?? `${this.id};${this.nextTrackedRangeId++}`;
		this.modelTrackedRanges.set(nextId, this.trackRange(Range.lift(newRange), newStickiness));
		return nextId;
	}

	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T, ownerId = 0): T | null {
		this.assertNotDisposed();
		validateDecorationOwnerId(ownerId);
		if (typeof callback !== 'function') throw new TypeError('Decoration change callback must be a function');
		const current = [...this.modelDecorations.values()].filter(entry => entry.ownerId === ownerId);
		const staged = new Map(current.map(entry => [entry.id, {
			id: entry.id,
			range: entry.trackedRange.range,
			options: entry.options,
		}]));
		let changed = false;
		const requireEntry = (id: string) => {
			const entry = staged.get(id);
			if (!entry) throw new RangeError(`Unknown model decoration '${id}'`);
			return entry;
		};
		const add = (range: IRange, options: IModelDecorationOptions, id = this.allocateDecorationId()) => {
			staged.set(id, { id, range: this.validateRange(range), options: validateDecorationOptions(options) });
			changed = true;
			return id;
		};
		const accessor: IModelDecorationsChangeAccessor = {
			addDecoration: (range, options) => add(range, options),
			changeDecoration: (id, range) => {
				const entry = requireEntry(id);
				staged.set(id, { ...entry, range: this.validateRange(range) });
				changed = true;
			},
			changeDecorationOptions: (id, options) => {
				const entry = requireEntry(id);
				staged.set(id, { ...entry, options: validateDecorationOptions(options) });
				changed = true;
			},
			removeDecoration: id => {
				requireEntry(id);
				staged.delete(id);
				changed = true;
			},
			deltaDecorations: (oldDecorations, newDecorations) => {
				if (new Set(oldDecorations).size !== oldDecorations.length) throw new RangeError('Decoration delta contains duplicate IDs');
				const previous = oldDecorations.map(requireEntry);
				const next = newDecorations.map((decoration, index) => ({
					id: previous[index]?.id ?? this.allocateDecorationId(),
					range: this.validateRange(decoration.range),
					options: validateDecorationOptions(decoration.options),
				}));
				for (const entry of previous) staged.delete(entry.id);
				for (const entry of next) staged.set(entry.id, entry);
				if (previous.length > 0 || next.length > 0) changed = true;
				return next.map(entry => entry.id);
			},
		};
		const result = callback(accessor);
		if (!changed) return result;
		const replacements: ModelDecorationEntry[] = [];
		try {
			for (const entry of staged.values()) {
				replacements.push({
					id: entry.id,
					ownerId,
					trackedRange: this.trackRange(entry.range, entry.options.stickiness ?? TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges),
					options: entry.options,
				});
			}
		} catch (error) {
			for (const entry of replacements) entry.trackedRange.dispose();
			throw error;
		}
		for (const entry of current) {
			this.modelDecorations.delete(entry.id);
		}
		for (const entry of replacements) this.modelDecorations.set(entry.id, entry);
		try {
			this.publishDecorationChanges(current, replacements);
		} finally {
			for (const entry of current) entry.trackedRange.dispose();
		}
		return result;
	}

	deltaDecorations(oldDecorations: string[], newDecorations: IModelDeltaDecoration[], ownerId = 0): string[] {
		this.assertNotDisposed();
		validateDecorationOwnerId(ownerId);
		if (new Set(oldDecorations).size !== oldDecorations.length) throw new RangeError('Decoration delta contains duplicate IDs');
		const previous = oldDecorations.map(id => {
			const entry = this.modelDecorations.get(id);
			if (!entry || entry.ownerId !== ownerId) throw new RangeError(`Unknown model decoration '${id}'`);
			return entry;
		});
		const staged: ModelDecorationEntry[] = [];
		try {
			for (let index = 0; index < newDecorations.length; index += 1) {
				const decoration = newDecorations[index];
				const range = this.validateRange(decoration.range);
				const options = validateDecorationOptions(decoration.options);
				const id = previous[index]?.id ?? this.allocateDecorationId();
				staged.push({
					id,
					ownerId,
					trackedRange: this.trackRange(range, options.stickiness ?? TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges),
					options,
				});
			}
		} catch (error) {
			for (const entry of staged) entry.trackedRange.dispose();
			throw error;
		}

		if (previous.length === 0 && staged.length === 0) return [];
		for (const entry of previous) {
			this.modelDecorations.delete(entry.id);
		}
		for (const entry of staged) this.modelDecorations.set(entry.id, entry);
		try {
			this.publishDecorationChanges(previous, staged);
		} finally {
			for (const entry of previous) entry.trackedRange.dispose();
		}
		return staged.map(entry => entry.id);
	}

	removeAllDecorationsWithOwnerId(ownerId: number): void {
		this.assertNotDisposed();
		validateDecorationOwnerId(ownerId);
		const removed = [...this.modelDecorations.values()].filter(entry => entry.ownerId === ownerId);
		if (removed.length === 0) return;
		for (const entry of removed) {
			this.modelDecorations.delete(entry.id);
		}
		try {
			this.publishDecorationChanges(removed, []);
		} finally {
			for (const entry of removed) entry.trackedRange.dispose();
		}
	}

	getDecorationRange(id: string): Range | null {
		this.assertNotDisposed();
		return this.modelDecorations.get(id)?.trackedRange.range ?? null;
	}

	getDecorationOptions(id: string): IModelDecorationOptions | null {
		this.assertNotDisposed();
		return this.modelDecorations.get(id)?.options ?? null;
	}

	getLineDecorations(lineNumber: number, ownerId = 0, filterOutValidation = false, filterFontDecorations = false): model.IModelDecoration[] {
		return this.getLinesDecorations(lineNumber, lineNumber, ownerId, filterOutValidation, filterFontDecorations);
	}

	getLinesDecorations(startLineNumber: number, endLineNumber: number, ownerId = 0, filterOutValidation = false, filterFontDecorations = false): model.IModelDecoration[] {
		this.assertNotDisposed();
		if (!Number.isSafeInteger(startLineNumber) || !Number.isSafeInteger(endLineNumber) || startLineNumber < 1 || endLineNumber < startLineNumber || endLineNumber > this.lineCount) {
			throw new RangeError(`Decoration line range must be between 1 and ${this.lineCount}`);
		}
		return this.getDecorationsInRange(new Range(startLineNumber, 1, endLineNumber, this.getLineMaxColumn(endLineNumber)), ownerId, filterOutValidation, filterFontDecorations);
	}

	getAllDecorations(ownerId = 0, filterOutValidation = false, filterFontDecorations = false): model.IModelDecoration[] {
		return this.getDecorationsInRange(this.getFullModelRange(), ownerId, filterOutValidation, filterFontDecorations);
	}

	getAllMarginDecorations(ownerId = 0): model.IModelDecoration[] {
		return this.getAllDecorations(ownerId).filter(decoration =>
			!!decoration.options.glyphMarginClassName || !!decoration.options.glyphMargin,
		);
	}

	getDecorationsInRange(
		range: IRange,
		ownerId = 0,
		filterOutValidation = false,
		filterFontDecorations = false,
		onlyMinimapDecorations = false,
		onlyMarginDecorations = false,
	): model.IModelDecoration[] {
		this.assertNotDisposed();
		const validatedRange = this.validateRange(range);
		const result: model.IModelDecoration[] = [];
		for (const entry of this.modelDecorations.values()) {
			if (ownerId !== 0 && entry.ownerId !== 0 && entry.ownerId !== ownerId) continue;
			if (filterOutValidation && isValidationDecoration(entry.options)) continue;
			if (filterFontDecorations && entry.options.affectsFont) continue;
			if (onlyMarginDecorations && !entry.options.glyphMarginClassName) continue;
			const decorationRange = entry.trackedRange.range;
			if (!Range.areIntersectingOrTouching(validatedRange, decorationRange)) continue;
			result.push({
				id: entry.id,
				ownerId: entry.ownerId,
				range: decorationRange,
				options: entry.options,
			});
		}
		if (!onlyMarginDecorations && !onlyMinimapDecorations) {
			result.push(...this.bracketDecorations.getDecorationsInRange(validatedRange, ownerId, filterOutValidation, filterFontDecorations));
		}
		return result;
	}

	getLineInjectedText(lineNumber: number, ownerId = 0): LineInjectedText[] {
		this.assertNotDisposed();
		if (lineNumber < 1 || lineNumber > this.getLineCount()) return [];
		const decorations = this.getDecorationsInRange(
			new Range(lineNumber, 1, lineNumber, this.getLineMaxColumn(lineNumber)),
			ownerId,
		);
		return LineInjectedText.fromDecorations(decorations).filter(text => text.lineNumber === lineNumber);
	}

	getInjectedTextDecorations(ownerId = 0): model.IModelDecoration[] {
		return this.getAllDecorations(ownerId).filter(decoration =>
			decoration.options.before !== null && decoration.options.before !== undefined
			|| decoration.options.after !== null && decoration.options.after !== undefined,
		);
	}

	getOverviewRulerDecorations(ownerId = 0, filterOutValidation = false, filterFontDecorations = false): model.IModelDecoration[] {
		return this.getDecorationsInRange(this.getFullModelRange(), ownerId, filterOutValidation, filterFontDecorations)
			.filter(decoration => !!decoration.options.overviewRuler?.color);
	}

	getFontDecorationsInRange(range: IRange, ownerId = 0): model.IModelDecoration[] {
		return this.getDecorationsInRange(range, ownerId).filter(decoration => !!decoration.options.affectsFont);
	}

	getCustomLineHeightsDecorations(ownerId = 0): model.IModelDecoration[] {
		return this.getDecorationsInRange(this.getFullModelRange(), ownerId)
			.filter(decoration => decoration.options.lineHeight !== null && decoration.options.lineHeight !== undefined);
	}

	getCustomLineHeightsDecorationsInRange(range: Range, ownerId = 0): model.IModelDecoration[] {
		return this.getDecorationsInRange(range, ownerId)
			.filter(decoration => decoration.options.lineHeight !== null && decoration.options.lineHeight !== undefined);
	}

	private allocateDecorationId(): string {
		return `${this.id};d${this.nextDecorationId++}`;
	}

	private emitDecorationsChanged(entries: Iterable<ModelDecorationEntry>): void {
		let affectsMinimap = false;
		let affectsOverviewRuler = false;
		let affectsGlyphMargin = false;
		let affectsLineNumber = false;
		for (const { options } of entries) {
			affectsMinimap ||= !!options.minimap;
			affectsOverviewRuler ||= !!options.overviewRuler;
			affectsGlyphMargin ||= !!options.glyphMargin || !!options.glyphMarginClassName;
			affectsLineNumber ||= !!options.lineNumberClassName;
		}
		this.decorationsEmitter.fire(Object.freeze({
			affectsMinimap,
			affectsOverviewRuler,
			affectsGlyphMargin,
			affectsLineNumber,
		}));
	}

	private publishDecorationChanges(previous: readonly ModelDecorationEntry[], current: readonly ModelDecorationEntry[]): void {
		const previousById = new Map(previous.map(entry => [entry.id, entry]));
		const currentById = new Map(current.map(entry => [entry.id, entry]));
		const ids = new Set([...previousById.keys(), ...currentById.keys()]);
		const changed: Array<{ previous?: ModelDecorationEntry; current?: ModelDecorationEntry }> = [];
		for (const id of ids) {
			const oldEntry = previousById.get(id);
			const newEntry = currentById.get(id);
			if (oldEntry && newEntry && oldEntry.options === newEntry.options && Range.equalsRange(oldEntry.trackedRange.range, newEntry.trackedRange.range)) continue;
			changed.push({ previous: oldEntry, current: newEntry });
		}

		const injectedLines = new Set<number>();
		const lineHeights: ModelLineHeightChanged[] = [];
		const fontLines = new Map<string, ModelFontChanged>();
		for (const pair of changed) {
			const oldEntry = pair.previous;
			const newEntry = pair.current;
			if (oldEntry && hasInjectedText(oldEntry.options)) injectedLines.add(oldEntry.trackedRange.range.startLineNumber);
			if (newEntry && hasInjectedText(newEntry.options)) injectedLines.add(newEntry.trackedRange.range.startLineNumber);

			const oldHeight = oldEntry?.options.lineHeight ?? null;
			const newHeight = newEntry?.options.lineHeight ?? null;
			const oldLine = oldEntry?.trackedRange.range.startLineNumber;
			const newLine = newEntry?.trackedRange.range.startLineNumber;
			if (oldEntry && oldHeight !== null && (newHeight !== oldHeight || newLine !== oldLine)) {
				lineHeights.push(new ModelLineHeightChanged(oldEntry.ownerId, oldEntry.id, oldLine!, null));
			}
			if (newEntry && newHeight !== null && (newHeight !== oldHeight || newLine !== oldLine)) {
				lineHeights.push(new ModelLineHeightChanged(newEntry.ownerId, newEntry.id, newLine!, newHeight));
			}

			for (const entry of [oldEntry, newEntry]) {
				if (!entry?.options.affectsFont) continue;
				const lineNumber = entry.trackedRange.range.startLineNumber;
				fontLines.set(`${entry.ownerId}:${lineNumber}`, new ModelFontChanged(entry.ownerId, lineNumber));
			}
		}

		if (injectedLines.size > 0) {
			const event = new ModelInjectedTextChangedEvent(
				[...injectedLines].sort((left, right) => left - right).map(line => new ModelRawLineChanged(line, line)),
			);
			this.publishToViewModels(event);
		}
		if (lineHeights.length > 0) this.lineHeightEmitter.fire(new ModelLineHeightChangedEvent(lineHeights));
		if (fontLines.size > 0) this.fontEmitter.fire(new ModelFontChangedEvent([...fontLines.values()]));
		this.emitDecorationsChanged(changed.flatMap(pair => [pair.previous, pair.current].filter((entry): entry is ModelDecorationEntry => !!entry)));
	}

	private publishTextChange(change: TextModelChange): void {
		const event = toInternalModelContentChangedEvent(change);
		// Views and token listeners may query brackets while processing this change.
		this._bracketPairs.handleDidChangeContent(event.contentChangedEvent);
		for (const viewModel of [...this.viewModels]) {
			try {
				viewModel.onDidChangeContentOrInjectedText(event);
			} catch (error) {
				onUnexpectedError(error);
			}
		}
		this.changeEmitter.fire(change);
		for (const viewModel of [...this.viewModels]) {
			try {
				viewModel.emitContentChangeEvent(event);
			} catch (error) {
				onUnexpectedError(error);
			}
		}
	}

	private publishToViewModels(event: ModelInjectedTextChangedEvent): void {
		for (const phase of ['update', 'emit'] as const) {
			for (const viewModel of [...this.viewModels]) {
				try {
					if (phase === 'update') viewModel.onDidChangeContentOrInjectedText(event);
					else viewModel.emitContentChangeEvent(event);
				} catch (error) {
					onUnexpectedError(error);
				}
			}
		}
	}

	beginHistoryRevision(historyGroup: UndoRedoGroup): void {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		this.history.beginRevision(historyGroup);
	}

	finishHistoryRevision(historyGroup: UndoRedoGroup): boolean {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		const entry = this.history.getRevisionEntry(historyGroup);
		if (entry && this.offsetEditsAreNoOps(entry.edits)) {
			this.history.discardRevision(historyGroup);
			return false;
		} else {
			return this.history.finishRevision(historyGroup);
		}
	}

	cancelHistoryRevision(
		historyGroup: UndoRedoGroup,
	): TextModelChange | undefined {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		const entry = this.history.cancelRevision(historyGroup);
		if (!entry || this.offsetEditsAreNoOps(entry.edits)) return undefined;
		const result = this.commitOffsetEdits(this.translateHistoryEdits(entry.edits, entry.editsEOL), {
			reason: TextModelChangeReason.HistoryCancellation,
			eol: entry.eol,
			transactionId: entry.transactionId,
			lineIds: entry.lineIds,
			resultingSelection: entry.beforeCursorState,
		});
		if (!result) {
			throw new Error("History revision contained an empty transaction");
		}
		this._alternativeVersion = entry.alternativeVersionId;
		this.publishTextChange(result.change);
		return result.change;
	}

	/**
	 * Atomically applies replacements expressed against the current document.
	 *
	 * Input order is irrelevant. Overlapping replacements, including two
	 * insertions at the same position, are rejected before any mutation.
	 */
	applyOperations(operations: readonly ISingleEditOperation[], options: TextEditOptions = {}): TextModelChange | undefined {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		if (!Array.isArray(operations)) throw new TypeError("Edit operations must be an array");
		const previousStepOpen = options.historyGroup === undefined
			&& this.history.findUndoEntry(undefined, () => true) !== undefined;
		const versionBefore = this._version;
		if (options.historyGroup === undefined) this.history.pushStackElement();
		let change: TextModelChange | undefined;
		try {
			change = this.pushEditOperationsWithOptions(null, operations, null, options)?.change;
			return change;
		} finally {
			if (options.historyGroup === undefined) {
				this.history.pushStackElement();
				if (!change && this._version === versionBefore && previousStepOpen) this.history.popStackElement();
			}
		}
	}

	edit(edit: TextEdit, options: { reason?: TextModelEditSource } = {}): void {
		this.pushEditOperations(
			null,
			edit.replacements.map(replacement => ({ range: replacement.range, text: replacement.text })),
			null,
			undefined,
			options.reason,
		);
	}

	pushStackElement(): void {
		this.assertNotDisposed();
		this.history.pushStackElement();
	}

	popStackElement(): void {
		this.assertNotDisposed();
		this.history.popStackElement();
	}

	pushEditOperations(
		beforeCursorState: Selection[] | null,
		editOperations: IIdentifiedSingleEditOperation[],
		cursorStateComputer: ICursorStateComputer | null,
		group?: UndoRedoGroup,
		reason?: TextModelEditSource,
	): Selection[] | null {
		return this.pushEditOperationsWithOptions(
			beforeCursorState,
			editOperations,
			cursorStateComputer,
			{
				historyGroup: group,
				editSource: reason ?? EditSources.unknown({ name: 'pushEditOperations' }),
			},
		)?.change.resultingSelection ?? null;
	}

	private pushEditOperationsWithOptions(
		beforeCursorState: Selection[] | null,
		editOperations: readonly IIdentifiedSingleEditOperation[],
		cursorStateComputer: ICursorStateComputer | null,
		options: TextEditOptions,
	): { readonly change: TextModelChange; readonly inverseEditOperations: IValidEditOperation[] } | undefined {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		if (!Array.isArray(editOperations)) throw new TypeError("Edit operations must be an array");
		const historyMergeMode =
			options.historyMergeMode ??
			TextEditHistoryMergeMode.Sequential;
		if (
			historyMergeMode !== TextEditHistoryMergeMode.Sequential &&
			historyMergeMode !== TextEditHistoryMergeMode.ReplacePrevious
		) {
			throw new TypeError("Unknown text edit history merge mode");
		}
		if (
			historyMergeMode === TextEditHistoryMergeMode.ReplacePrevious &&
			(!options.historyGroup ||
				!this.history.isRevisionActive(options.historyGroup))
		) {
			throw new Error(
				"ReplacePrevious requires an active history revision",
			);
		}
		const validatedOperations = this.validateEditOperations(editOperations);
		const offsetEdits = validatedOperations.map(edit => {
			const range = edit.range;
			return {
				startOffset: this.offsetAt(range.getStartPosition()),
				endOffset: this.offsetAt(range.getEndPosition()),
				text: this.normalizeTextToBufferEOL(edit.text ?? ''),
			};
		});
		const sortedOffsetEdits = [...offsetEdits].sort(compareOffsetEdits);
		const coalescingEntry = this.findCoalescingEntry(
			sortedOffsetEdits,
			options.historyGroup,
			historyMergeMode,
		);
		const previousAlternativeVersionId = this._alternativeVersion;
		const previousEOL = this.getEndOfLineSequence();
		const result = this.commitEditOperations(
			validatedOperations,
			{
				reason: TextModelChangeReason.Edit,
				transactionId: coalescingEntry?.transactionId,
				editSource: options.editSource,
				cursorStateComputer,
			},
		);
		if (!result) return undefined;
		this.history.prepareForEdit(options.historyGroup);
		this.history.clearRedo();
		if (coalescingEntry) {
			const mergedTextChanges = compressConsecutiveTextChanges(
				[...coalescingEntry.textChanges],
				result.textChanges,
			);
			const accumulatesActiveRevision = options.historyGroup !== undefined
				&& historyMergeMode === TextEditHistoryMergeMode.Sequential
				&& this.history.isRevisionActive(options.historyGroup);
			const mergedEdits = options.historyGroup === undefined || accumulatesActiveRevision
				? inverseEditsFromTextChanges(mergedTextChanges)
				: historyMergeMode === TextEditHistoryMergeMode.ReplacePrevious
					? replaceHistoryUndoEdits(
						coalescingEntry.edits,
						result.inverseEdits,
					)
					: coalesceHistoryUndoEdits(
						coalescingEntry.edits,
						sortedOffsetEdits,
						result.inverseEdits,
					);
			this.history.replaceUndoEntry(
				coalescingEntry,
				mergedEdits,
				mergedTextChanges,
				result.change.resultingSelection,
			);
		} else {
			this.history.pushUndo(
				result.inverseEdits,
				result.change.transactionId,
				previousAlternativeVersionId,
				previousEOL,
				previousEOL,
				options.historyGroup,
				result.previousLineIds,
				beforeCursorState,
				result.change.resultingSelection,
				result.textChanges,
			);
		}
		this.publishTextChange(result.change);
		return result;
	}

	applyEdits(operations: readonly IIdentifiedSingleEditOperation[]): void;
	applyEdits(operations: readonly IIdentifiedSingleEditOperation[], reason: TextModelEditSource): void;
	applyEdits(operations: readonly IIdentifiedSingleEditOperation[], computeUndoEdits: false): void;
	applyEdits(operations: readonly IIdentifiedSingleEditOperation[], computeUndoEdits: true): IValidEditOperation[];
	applyEdits(
		operations: readonly IIdentifiedSingleEditOperation[],
		computeUndoEditsOrReason: boolean | TextModelEditSource = false,
	): void | IValidEditOperation[] {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		if (!Array.isArray(operations)) throw new TypeError("Edit operations must be an array");
		const computeUndoEdits = typeof computeUndoEditsOrReason === 'boolean'
			? computeUndoEditsOrReason
			: false;
		const reason = typeof computeUndoEditsOrReason === 'boolean'
			? EditSources.applyEdits()
			: computeUndoEditsOrReason;
		const result = this.commitEditOperations(
			this.validateEditOperations(operations),
			{ reason: TextModelChangeReason.Edit, editSource: reason },
		);
		if (result) this.publishTextChange(result.change);
		return computeUndoEdits ? result?.inverseEditOperations ?? [] : undefined;
	}

	_applyUndo(changes: TextChange[], eol: EndOfLineSequence, resultingAlternativeVersionId: number, resultingSelection: Selection[] | null): void {
		this.applyUndoRedoChanges(changes, eol, resultingAlternativeVersionId, resultingSelection, true);
	}

	_applyRedo(changes: TextChange[], eol: EndOfLineSequence, resultingAlternativeVersionId: number, resultingSelection: Selection[] | null): void {
		this.applyUndoRedoChanges(changes, eol, resultingAlternativeVersionId, resultingSelection, false);
	}

	private applyUndoRedoChanges(
		changes: TextChange[],
		eol: EndOfLineSequence,
		resultingAlternativeVersionId: number,
		resultingSelection: Selection[] | null,
		undoing: boolean,
	): void {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		if (!Array.isArray(changes)) throw new TypeError('Undo and redo changes must be an array');
		if (!Number.isSafeInteger(resultingAlternativeVersionId) || resultingAlternativeVersionId < 1) {
			throw new RangeError('Undo and redo alternative version must be a positive safe integer');
		}
		const targetEOL = requireEndOfLineSequence(eol);
		const edits = changes.map(change => ({
			startOffset: undoing ? change.newPosition : change.oldPosition,
			endOffset: undoing ? change.newEnd : change.oldEnd,
			text: this.normalizeTextToBufferEOL(undoing ? change.oldText : change.newText),
		}));
		const result = this.commitOffsetEdits(edits, {
			reason: undoing ? TextModelChangeReason.Undo : TextModelChangeReason.Redo,
			eol: targetEOL,
			resultingSelection,
		});
		this._alternativeVersion = resultingAlternativeVersionId;
		if (result) this.publishTextChange(result.change);
	}

	/** Clears edit history and replaces document content as a non-undoable reset. */
	reset(text: string, editSource: TextModelEditSource = EditSources.setValue()): TextModelChange {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		if (typeof text !== "string") {
			throw new TypeError("TextModel reset text must be a string");
		}
		const nextBuffer = createPieceTreeTextBuffer(text, this.modelOptionsValue.defaultEOL);
		const previousBuffer = this.buffer;
		let result: CommitResult | undefined;
		try {
			result = this.commitOffsetEdits([{
				startOffset: 0,
				endOffset: previousBuffer.getLength(),
				text: nextBuffer.createSnapshot().getText(),
			}], {
				reason: TextModelChangeReason.Reset,
				editSource,
				eol: nextBuffer.getEOL() === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF,
			});
		} catch (error) {
			nextBuffer.dispose();
			throw error;
		}
		this.history.reset();
		this.buffer = nextBuffer;
		previousBuffer.dispose();
		if (result) {
			this.publishTextChange(result.change);
			return result.change;
		}
		this._version += 1;
		this._alternativeVersion = this._version;
		const change = Object.freeze<TextModelChange>({
			version: this._version,
			transactionId: this.nextTransactionId++,
			reason: TextModelChangeReason.Reset,
			changes: Object.freeze([]),
			eol: this.buffer.getEOL(),
			isEolChange: false,
			detailedReasons: Object.freeze([editSource]),
			resultingSelection: null,
		});
		this.publishTextChange(change);
		return change;
	}

	undo(): TextModelChange | undefined {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		this.history.prepareForEdit(undefined);
		const entry = this.history.takeUndo();
		if (!entry) return undefined;
		const previousAlternativeVersionId = this._alternativeVersion;
		const previousEOL = this.getEndOfLineSequence();
		const result = this.commitOffsetEdits(
			this.translateHistoryEdits(entry.edits, entry.editsEOL),
			{
				reason: TextModelChangeReason.Undo,
				eol: entry.eol,
				transactionId: entry.transactionId,
				lineIds: entry.lineIds,
				resultingSelection: entry.beforeCursorState,
			},
		);
		if (!result) {
			throw new Error("Undo history contained an empty transaction");
		}
		this.history.pushRedo(
			result.inverseEdits,
			entry.transactionId,
			previousAlternativeVersionId,
			entry.eol,
			previousEOL,
			entry.historyGroup,
			result.previousLineIds,
			entry.beforeCursorState,
			entry.afterCursorState,
			result.textChanges,
		);
		this._alternativeVersion = entry.alternativeVersionId;
		this.publishTextChange(result.change);
		return result.change;
	}

	redo(): TextModelChange | undefined {
		this.assertNotDisposed();
		this.ensureDirectTextMutationAllowed();
		this.history.prepareForEdit(undefined);
		const entry = this.history.takeRedo();
		if (!entry) return undefined;
		const previousAlternativeVersionId = this._alternativeVersion;
		const previousEOL = this.getEndOfLineSequence();
		const result = this.commitOffsetEdits(
			this.translateHistoryEdits(entry.edits, entry.editsEOL),
			{
				reason: TextModelChangeReason.Redo,
				eol: entry.eol,
				transactionId: entry.transactionId,
				lineIds: entry.lineIds,
				resultingSelection: entry.afterCursorState,
			},
		);
		if (!result) {
			throw new Error("Redo history contained an empty transaction");
		}
		this.history.pushUndo(
			result.inverseEdits,
			entry.transactionId,
			previousAlternativeVersionId,
			entry.eol,
			previousEOL,
			entry.historyGroup,
			result.previousLineIds,
			entry.beforeCursorState,
			entry.afterCursorState,
			result.textChanges,
		);
		this.history.pushStackElement();
		this._alternativeVersion = entry.alternativeVersionId;
		this.publishTextChange(result.change);
		return result.change;
	}

	private findCoalescingEntry(
		edits: readonly OffsetEdit[],
		historyGroup: UndoRedoGroup | undefined,
		historyMergeMode: TextEditHistoryMergeMode,
	): TextModelHistoryEntry | undefined {
		return this.history.findUndoEntry(
			historyGroup,
			previous => historyGroup === undefined || (
				historyMergeMode === TextEditHistoryMergeMode.ReplacePrevious
					? canReplaceHistoryEdits(previous.edits, edits)
					: this.history.isRevisionActive(historyGroup) || canCoalesceHistoryEdits(previous.edits, edits)
			),
		);
	}

	private validateEditOperation(rawOperation: IIdentifiedSingleEditOperation): ValidAnnotatedEditOperation {
		if (rawOperation instanceof ValidAnnotatedEditOperation) return rawOperation;
		const range = this.validateRange(rawOperation.range);
		let text = rawOperation.text;
		if (
			text &&
			this.getEOL() === '\r\n' &&
			text.charCodeAt(text.length - 1) === 13 &&
			range.endColumn === this.getLineMaxColumn(range.endLineNumber)
		) {
			text = text.slice(0, -1);
		}
		return new ValidAnnotatedEditOperation(
			rawOperation.identifier ?? null,
			range,
			text,
			rawOperation.forceMoveMarkers ?? false,
			rawOperation.isAutoWhitespaceEdit ?? false,
			rawOperation._isTracked ?? false,
		);
	}

	private validateEditOperations(rawOperations: readonly IIdentifiedSingleEditOperation[]): ValidAnnotatedEditOperation[] {
		return rawOperations.map(operation => this.validateEditOperation(operation));
	}

	private commitOffsetEdits(
		edits: readonly OffsetEdit[],
		context: CommitContext,
	): CommitResult | undefined {
		return this.commitAnnotatedOffsetEdits(
			edits.map(edit => ({
				...edit,
				identifier: null,
				forceMoveMarkers: false,
				isAutoWhitespaceEdit: false,
				_isTracked: false,
			})),
			context,
		);
	}

	private commitEditOperations(
		operations: readonly ValidAnnotatedEditOperation[],
		context: CommitContext,
	): CommitResult | undefined {
		return this.commitAnnotatedOffsetEdits(
			operations.map(operation => ({
				startOffset: this.offsetAt(operation.range.getStartPosition()),
				endOffset: this.offsetAt(operation.range.getEndPosition()),
				text: operation.text ?? '',
				identifier: operation.identifier,
				forceMoveMarkers: operation.forceMoveMarkers,
				isAutoWhitespaceEdit: operation.isAutoWhitespaceEdit,
				_isTracked: operation._isTracked,
			})),
			context,
		);
	}

	private commitAnnotatedOffsetEdits(
		edits: readonly AnnotatedOffsetEdit[],
		context: CommitContext,
	): CommitResult | undefined {
		const previousEOL = this.getEndOfLineSequence();
		const targetEOL = context.eol ?? previousEOL;
		const prepared = this.prepareEdits(edits);
		const eolChanged = targetEOL !== previousEOL;
		if (prepared.length === 0 && !eolChanged) return undefined;
		const previousLineIds = this.plainLineIds;
		const reservedLineIds = new Set<LineId>();
		let nextLineIds: readonly LineId[] | undefined;
		if (previousLineIds) {
			const projectedLineIds = this.projectLineIds(prepared);
			nextLineIds = context.lineIds === undefined
				? this.mapLineIds(projectedLineIds, reservedLineIds)
				: this.validateCommittedLineIds(context.lineIds, projectedLineIds.length);
		}

		const bufferResult = this.buffer.applyEdits(
			prepared.map(edit => new ValidAnnotatedEditOperation(
				edit.identifier ?? null,
				edit.range,
				edit.text,
				edit.forceMoveMarkers,
				edit.isAutoWhitespaceEdit,
				edit._isTracked,
			)),
			this.modelOptionsValue.trimAutoWhitespace,
			true,
		);
		const inverseEditOperations = bufferResult.reverseEdits ?? [];
		const textChanges = inverseEditOperations
			.map((operation, index) => ({ index, textChange: operation.textChange }))
			.sort((left, right) => left.textChange.oldPosition - right.textChange.oldPosition || left.index - right.index)
			.map(entry => entry.textChange);
		const inverseEdits = inverseEditOperations.map<OffsetEdit>(operation => ({
			startOffset: this.buffer.getOffsetAt(operation.range.startLineNumber, operation.range.startColumn),
			endOffset: this.buffer.getOffsetAt(operation.range.endLineNumber, operation.range.endColumn),
			text: operation.text,
		})).sort(compareOffsetEdits);
		const appliedChanges = Object.freeze(
			bufferResult.changes
				.slice()
				.sort((left, right) => left.rangeOffset - right.rangeOffset || left.rangeLength - right.rangeLength)
				.map<TextModelContentChange>(change => Object.freeze({
					range: change.range,
					rangeOffset: change.rangeOffset,
					rangeLength: change.rangeLength,
					text: change.text,
				})),
		);
		if (nextLineIds) {
			if (nextLineIds.length !== this.buffer.getLineCount()) throw new Error("TextModel line identity mapping diverged from the ITextBuffer");
			this.plainLineIds = nextLineIds;
			for (const lineId of context.lineIds === undefined ? reservedLineIds : nextLineIds) this.issuedLineIds.add(lineId);
			this.plainLineSnapshot = undefined;
		}
		this.trackedRanges.acceptChanges(appliedChanges);
		let committedInverseEdits: OffsetEdit[] = inverseEdits;
		if (eolChanged) {
			const eolLengthDelta = endOfLineText(targetEOL).length - endOfLineText(previousEOL).length;
			committedInverseEdits = inverseEdits.map(edit => {
				const start = this.buffer.getPositionAt(edit.startOffset);
				const end = this.buffer.getPositionAt(edit.endOffset);
				return {
					...edit,
					startOffset: edit.startOffset + (start.lineNumber - 1) * eolLengthDelta,
					endOffset: edit.endOffset + (end.lineNumber - 1) * eolLengthDelta,
				};
			});
			this.trackedRanges.acceptEOLChange(eolLengthDelta);
			this.buffer.setEOL(endOfLineText(targetEOL));
		}
		this.scheduleMaintenance();

		const resultingSelection = context.cursorStateComputer
			? this.computeCursorState(context.cursorStateComputer, inverseEditOperations)
			: cloneSelections(context.resultingSelection ?? null);
		const transactionId = context.transactionId ?? this.nextTransactionId++;
		this._version += 1;
		this._alternativeVersion = this._version;
		const changes = eolChanged
			? Object.freeze(appliedChanges.map(change => Object.freeze({
				...change,
				text: normalizeTextToEOL(change.text, endOfLineText(targetEOL)),
			})))
			: appliedChanges;
		const change = Object.freeze<TextModelChange>({
			version: this._version,
			transactionId,
			reason: context.reason,
			changes,
			eol: endOfLineText(targetEOL),
			isEolChange: eolChanged && changes.length === 0,
			detailedReasons: Object.freeze(context.editSource ? [context.editSource] : []),
			resultingSelection,
		});
		return {
			change,
			inverseEdits: normalizeInverseEdits(committedInverseEdits),
			inverseEditOperations,
			textChanges,
			previousLineIds,
		};
	}

	private computeCursorState(
		cursorStateComputer: ICursorStateComputer,
		inverseEditOperations: IValidEditOperation[],
	): Selection[] | null {
		try {
			return cloneSelections(cursorStateComputer(inverseEditOperations));
		} catch (error) {
			onUnexpectedError(error);
			return null;
		}
	}

	private scheduleMaintenance(): void {
		if (!this.buffer.needsMaintenance()) return;
		const maintenance = this.maintenance;
		if (!maintenance) {
			this.buffer.maintain();
			return;
		}
		if (this.pendingMaintenance.value) return;
		let pending: IDisposable;
		let ranSynchronously = false;
		try {
			pending = maintenance.schedule(() => {
				ranSynchronously = true;
				this.pendingMaintenance.clear();
				if (!this.isDisposed()) this.buffer.maintainIfNeeded();
			});
			if (!pending || typeof pending.dispose !== "function") {
				throw new TypeError("TextModel maintenance scheduler must return a disposable");
			}
		} catch {
			this.buffer.maintain();
			return;
		}
		if (ranSynchronously) {
			pending.dispose();
			return;
		}
		this.pendingMaintenance.value = pending;
	}

	private prepareEdits(edits: readonly AnnotatedOffsetEdit[]): PreparedEdit[] {
		const sorted = edits.map(edit => {
			this.assertOffsetRange(edit);
			return {
				...edit,
				text: this.normalizeTextToBufferEOL(edit.text),
			};
		}).sort(compareOffsetEdits);

		for (let index = 1; index < sorted.length; index += 1) {
			const previous = sorted[index - 1];
			const current = sorted[index];
			const ambiguousSharedStart =
				current.startOffset === previous.startOffset &&
				(current.startOffset === current.endOffset ||
					previous.startOffset === previous.endOffset);
			if (
				current.startOffset < previous.endOffset ||
				ambiguousSharedStart
			) {
				throw new RangeError("Text edits must not overlap");
			}
		}

		return sorted.flatMap<PreparedEdit>(edit => {
			const replacedText = this.buffer.getValueInRange(this.buffer.getRangeAt(edit.startOffset, edit.endOffset - edit.startOffset));
			if (replacedText === edit.text) return [];
			return [{
				...edit,
				range: Range.fromPositions(
					this.positionAt(edit.startOffset),
					this.positionAt(edit.endOffset),
				),
				replacedText,
			}];
		});
	}

	private assertOffsetRange(edit: OffsetEdit): void {
		if (
			!Number.isSafeInteger(edit.startOffset) ||
			!Number.isSafeInteger(edit.endOffset) ||
			edit.startOffset < 0 ||
			edit.endOffset < edit.startOffset ||
			edit.endOffset > this.buffer.getLength()
		) {
			throw new RangeError(
				`Text edit offsets must satisfy 0 <= start <= end <= ${this.buffer.getLength()}`,
			);
		}
	}

	private offsetEditsAreNoOps(edits: readonly OffsetEdit[]): boolean {
		return edits.every(edit => this.buffer.getValueInRange(this.buffer.getRangeAt(edit.startOffset, edit.endOffset - edit.startOffset)) === edit.text);
	}

	/** Commits flattened line text for one already-validated block transaction. */
	private commitBlockText(text: string): { readonly version: number; readonly change?: TextModelChange } {
		const previousText = this.buffer.createSnapshot().getText();
		const nextText = this.normalizeTextToBufferEOL(text);
		let prefixLength = 0;
		const maximumPrefixLength = Math.min(previousText.length, nextText.length);
		while (prefixLength < maximumPrefixLength && previousText.charCodeAt(prefixLength) === nextText.charCodeAt(prefixLength)) prefixLength += 1;
		let suffixLength = 0;
		const maximumSuffixLength = Math.min(previousText.length - prefixLength, nextText.length - prefixLength);
		while (
			suffixLength < maximumSuffixLength &&
			previousText.charCodeAt(previousText.length - suffixLength - 1) === nextText.charCodeAt(nextText.length - suffixLength - 1)
		) suffixLength += 1;
		const result = this.commitOffsetEdits([{
			startOffset: prefixLength,
			endOffset: previousText.length - suffixLength,
			text: nextText.slice(prefixLength, nextText.length - suffixLength),
		}], { reason: TextModelChangeReason.Blocks });
		this.history.reset();
		if (result) return { version: this._version, change: result.change };
		this._version += 1;
		this._alternativeVersion = this._version;
		const change = Object.freeze<TextModelChange>({
			version: this._version,
			transactionId: this.nextTransactionId++,
			reason: TextModelChangeReason.Blocks,
			eol: this.buffer.getEOL(),
			isEolChange: false,
			detailedReasons: Object.freeze([]),
			resultingSelection: null,
			changes: Object.freeze([Object.freeze<TextModelContentChange>({
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), this.positionAt(this.buffer.getLength())),
				rangeOffset: 0,
				rangeLength: this.buffer.getLength(),
				text: previousText,
			})]),
		});
		return { version: this._version, change };
	}

	private initializeLineIds(lineIds: readonly LineId[] | undefined): readonly LineId[] {
		if (lineIds !== undefined) {
			if (!Array.isArray(lineIds) || lineIds.length !== this.buffer.getLineCount()) {
				throw new RangeError(`TextModel requires exactly ${this.buffer.getLineCount()} line ids`);
			}
			const validated = this.validateLineIdentities(lineIds);
			for (const lineId of validated) this.issuedLineIds.add(lineId);
			return validated;
		}
		return Object.freeze(Array.from({ length: this.buffer.getLineCount() }, () => this.allocateLineId()));
	}

	private projectLineIds(prepared: readonly PreparedEdit[]): readonly (LineId | undefined)[] {
		const lineEdit = LengthEdit.create(prepared.map(edit => new LengthReplacement(
			new OffsetRange(edit.range.startLineNumber, edit.range.endLineNumber),
			countEOL(edit.text)[0],
		)));
		const projected = lineEdit.applyArray<LineId | undefined>(this.plainLineIds!, undefined);
		const expected = this.buffer.getLineCount() + prepared.reduce((delta, edit) =>
			delta + countEOL(edit.text)[0] - (edit.range.endLineNumber - edit.range.startLineNumber), 0);
		if (projected.length !== expected) throw new Error("TextModel line identity projection does not match the edit ranges");
		return projected;
	}

	private mapLineIds(projected: readonly (LineId | undefined)[], reserved: Set<LineId>): readonly LineId[] {
		return Object.freeze(projected.map(lineId => lineId ?? this.allocateLineId(reserved)));
	}

	private validateCommittedLineIds(lineIds: readonly LineId[], expected: number): readonly LineId[] {
		if (lineIds.length !== expected) {
			throw new RangeError(`Committed TextModel state requires exactly ${expected} line ids`);
		}
		return this.validateLineIdentities(lineIds);
	}

	private validateLineIdentities(lineIds: readonly LineId[]): readonly LineId[] {
		const unique = new Set<LineId>();
		for (const lineId of lineIds) {
			if (typeof lineId !== "string" || lineId.trim().length === 0) throw new TypeError("TextModel line ids must be non-empty strings");
			if (unique.has(lineId)) throw new TypeError(`Duplicate TextModel line id '${lineId}'`);
			unique.add(lineId);
		}
		return Object.freeze([...lineIds]);
	}

	private allocateLineId(reserved: Set<LineId> = this.issuedLineIds): LineId {
		for (let attempt = 0; attempt < 1_000; attempt += 1) {
			const lineId = this.lineIdGenerator();
			if (typeof lineId !== "string" || lineId.trim().length === 0) {
				throw new TypeError("TextModel lineIdGenerator must return a non-empty string");
			}
			if (this.issuedLineIds.has(lineId) || reserved.has(lineId)) continue;
			reserved.add(lineId);
			return lineId;
		}
		throw new Error("TextModel lineIdGenerator did not produce a unique identity");
	}

	private requirePlainLineSnapshot(): LineDocumentSnapshot {
		const existing = this.plainLineSnapshot;
		if (existing) return existing;
		const snapshot = this.createPlainLineSnapshot(this.lineMetadata);
		this.plainLineSnapshot = snapshot;
		return snapshot;
	}

	private createPlainLineSnapshot(metadata: LineSemanticAttributes | undefined): LineDocumentSnapshot {
		const lineIds = this.plainLineIds;
		if (!lineIds || lineIds.length !== this.buffer.getLineCount()) throw new Error("TextModel plain line identities are unavailable");
		return createLineDocumentSnapshot({
			lines: lineIds.map((id, lineIndex) => ({ id, text: this.buffer.getLineContent(lineIndex + 1) })),
			metadata,
		});
	}

	private requireBlockState(): TextModelBlockState {
		this.assertNotDisposed();
		const blockState = this.blockState;
		if (!blockState) throw new ReferenceError("TextModel has no schema-backed Block state");
		return blockState;
	}

	private normalizeTextToBufferEOL(text: string): string {
		return normalizeTextToEOL(text, this.buffer.getEOL());
	}

	private translateHistoryEdits(edits: readonly OffsetEdit[], editsEOL: EndOfLineSequence): OffsetEdit[] {
		const currentEOL = this.getEndOfLineSequence();
		if (editsEOL === currentEOL) return edits.map(edit => ({ ...edit }));
		const sourceBuffer = createPieceTreeTextBuffer(
			normalizeTextToEOL(this.buffer.createSnapshot().getText(), endOfLineText(editsEOL)),
			editsEOL === EndOfLineSequence.CRLF ? DefaultEndOfLine.CRLF : DefaultEndOfLine.LF,
		);
		return edits.map(edit => {
			const start = sourceBuffer.getPositionAt(edit.startOffset);
			const end = sourceBuffer.getPositionAt(edit.endOffset);
			return {
				startOffset: this.buffer.getOffsetAt(start.lineNumber, start.column),
				endOffset: this.buffer.getOffsetAt(end.lineNumber, end.column),
				text: edit.text,
			};
		});
	}

	private ensureDirectTextMutationAllowed(): void {
		if (this.blockState) throw new Error("TextModel edits must update schema-backed Blocks through dispatch()");
	}

	public isDisposed(): boolean {
		return this.disposed;
	}

	public dispose(): void {
		if (this.disposed || this.disposing) return;
		this.disposing = true;
		try {
			this.willDisposeEmitter.fire();
		} finally {
			this.disposing = false;
			this.disposed = true;
			this.modelTrackedRanges.clear();
			this.modelDecorations.clear();
			this.attachedViews.clear();
			this.viewModels.clear();
			this.disposables.dispose();
		}
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}

	private _register<T extends IDisposable | null | undefined>(resource: T): T {
		return this.disposables.add(resource);
	}

	private assertNotDisposed(): void {
		if (this.disposed) throw new ReferenceError('TextModel is already disposed');
	}

}

export function getLineTokensWithInjections(tokens: LineTokens, injectionOptions: model.InjectedTextOptions[] | null, injectionOffsets: number[] | null): LineTokens {
	if (!injectionOffsets) return tokens;
	const tokensToInsert: { offset: number; text: string; tokenMetadata: number }[] = [];
	for (let index = 0; index < injectionOffsets.length; index += 1) {
		const offset = injectionOffsets[index]!;
		const options = injectionOptions![index]!;
		if (options.tokens) {
			options.tokens.forEach((range, info) => {
				tokensToInsert.push({ offset, text: range.substring(options.content), tokenMetadata: info.metadata });
			});
		} else {
			tokensToInsert.push({ offset, text: options.content, tokenMetadata: LineTokens.defaultTokenMetadata });
		}
	}
	return tokens.withInserted(tokensToInsert);
}

function toModelContentChangedEvent(change: TextModelChange): IModelContentChangedEvent {
	const changes = change.changes.map(contentChange => ({ ...contentChange }))
		.sort((left, right) => Range.compareRangesUsingStarts(right.range, left.range));
	const detailedReasons = [...change.detailedReasons];
	return {
		changes,
		eol: change.eol,
		versionId: change.version,
		isUndoing: change.reason === TextModelChangeReason.Undo,
		isRedoing: change.reason === TextModelChangeReason.Redo,
		isFlush: change.reason === TextModelChangeReason.Reset,
		isEolChange: change.isEolChange,
		detailedReasons,
		detailedReasonsChangeLengths: detailedReasons.map((_, index) => index === 0 ? changes.length : 0),
	};
}

function toInternalModelContentChangedEvent(change: TextModelChange): InternalModelContentChangeEvent {
	const structural = change.changes.some(contentChange =>
		contentChange.range.startLineNumber !== contentChange.range.endLineNumber
		|| countEOL(contentChange.text)[0] > 0,
	);
	const rawChanges = change.isEolChange
		? [new ModelRawEOLChanged()]
		: change.reason === TextModelChangeReason.Reset || structural
			? [new ModelRawFlush()]
			: [...new Set(change.changes.map(contentChange => contentChange.range.startLineNumber))]
				.map(lineNumber => new ModelRawLineChanged(lineNumber, lineNumber));
	const rawEvent = new ModelRawContentChangedEvent(
		rawChanges,
		change.version,
		change.reason === TextModelChangeReason.Undo,
		change.reason === TextModelChangeReason.Redo,
	);
	rawEvent.resultingSelection = cloneSelections(change.resultingSelection);
	return new InternalModelContentChangeEvent(rawEvent, toModelContentChangedEvent(change));
}

function hasInjectedText(options: IModelDecorationOptions): boolean {
	return options.before !== null && options.before !== undefined
		|| options.after !== null && options.after !== undefined;
}

function compareOffsetEdits(left: OffsetEdit, right: OffsetEdit): number {
	return left.startOffset - right.startOffset ||
		left.endOffset - right.endOffset;
}

function cloneSelections(selections: readonly Selection[] | null): Selection[] | null {
	return selections?.map(Selection.liftSelection) ?? null;
}

function validateDecorationOptions(options: IModelDecorationOptions): IModelDecorationOptions {
	if (!options || typeof options.description !== 'string' || options.description.length === 0) {
		throw new TypeError('Model decoration options require a non-empty description');
	}
	if (options.stickiness !== undefined && !Object.values(TrackedRangeStickiness).includes(options.stickiness)) {
		throw new RangeError('Unknown model decoration stickiness');
	}
	return Object.freeze({ ...options });
}

function validateDecorationOwnerId(ownerId: number): void {
	if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new RangeError('Decoration ownerId must be a non-negative safe integer');
}

function isValidationDecoration(options: IModelDecorationOptions): boolean {
	return options.className === 'squiggly-error' ||
		options.className === 'squiggly-warning' ||
		options.className === 'squiggly-info';
}

function inverseEditsFromTextChanges(changes: readonly TextChange[]): OffsetEdit[] {
	return normalizeInverseEdits(changes.map(change => ({
		startOffset: change.newPosition,
		endOffset: change.newEnd,
		text: change.oldText,
	})).sort(compareOffsetEdits));
}

function readHistoryLimit(
	value: number | undefined,
	defaultValue: number,
	name: string,
): number {
	const resolved = value ?? defaultValue;
	if (!Number.isSafeInteger(resolved) || resolved < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
	return resolved;
}

function readMaintenanceOptions(value: TextModelMaintenanceOptions | undefined): TextModelMaintenanceOptions | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value.schedule !== "function") {
		throw new TypeError("TextModel maintenance requires a scheduler");
	}
	return Object.freeze({ schedule: value.schedule });
}

function createSearchQuery(
	pattern: string,
	isRegex: boolean,
	matchCase: boolean,
	wordSeparators: string | null,
): TextModelSearchQuery {
	return {
		pattern,
		patternKind: isRegex ? TextSearchPatternKind.RegularExpression : TextSearchPatternKind.Literal,
		matchCase,
		wholeWord: wordSeparators !== null,
		wordSeparators: wordSeparators ?? undefined,
	};
}

function mergeSearchScopes(scopes: readonly Range[]): Range[] {
	if (scopes.length === 0) return [];
	const sorted = [...scopes].sort(Range.compareRangesUsingStarts);
	const result: Range[] = [];
	let current = sorted[0]!;
	for (let index = 1; index < sorted.length; index++) {
		const candidate = sorted[index]!;
		if (Range.areIntersectingOrTouching(current, candidate)) current = current.plusRange(candidate);
		else {
			result.push(current);
			current = candidate;
		}
	}
	result.push(current);
	return result;
}

function toFindMatch(match: TextSearchMatch, captureMatches: boolean): FindMatch {
	return new FindMatch(
		match.range,
		captureMatches ? [match.text, ...match.captures.map(value => value ?? '')] : null,
	);
}

function requireLanguageId(languageId: string): string {
	if (typeof languageId !== 'string' || languageId.trim().length === 0) {
		throw new TypeError('TextModel language id must be a non-empty string');
	}
	return languageId;
}

function requireEndOfLineSequence(eol: EndOfLineSequence): EndOfLineSequence {
	if (eol !== EndOfLineSequence.LF && eol !== EndOfLineSequence.CRLF) throw new TypeError('Unknown end-of-line sequence');
	return eol;
}

function endOfLineText(eol: EndOfLineSequence): '\n' | '\r\n' {
	return eol === EndOfLineSequence.CRLF ? '\r\n' : '\n';
}

function normalizeTextToEOL(text: string, eol: '\n' | '\r\n'): string {
	return text.replace(/\r\n|\r|\n/g, eol);
}

/** Owns diagnostic requests independently of tokenization and its Worker. */
class ModelLanguageDiagnostics extends Disposable {
	private readonly coordinator: LanguageRequestCoordinator<SyntaxLane, SyntaxRequest, SyntaxResult>;
	private readonly errors = this._register(new Emitter<unknown>());
	readonly onDidEncounterError = this.errors.event;
	readonly results: ReturnType<typeof createLanguageDiagnosticStore>;
	private generation = 0;

	constructor(private readonly model: TextModel, registry?: SyntaxProviderRegistry, onDidChangeConfiguration?: Event<unknown>) {
		super();
		const providers = registry ?? this._register(new SyntaxProviderRegistry());
		this.results = this._register(createLanguageDiagnosticStore(model));
		this.coordinator = this._register(new LanguageRequestCoordinator(model, () => new SyntaxProviderWorker(providers, undefined, undefined, model)));
		this._register(model.onDidChangeContent(() => this.schedule()));
		this._register(model.onDidChangeLanguage(() => this.reset()));
		this._register(providers.onDidChange(() => this.reset()));
		if (onDidChangeConfiguration) this._register(onDidChangeConfiguration(() => this.reset()));
		this.schedule();
	}

	private reset(): void {
		this.coordinator.restartWorker();
		this.results.clear();
		this.schedule();
	}

	private schedule(): void {
		const generation = ++this.generation;
		if (this.model.largeFile.tooLargeForTokenization) return;
		queueMicrotask(() => {
			if (this.isDisposed || generation !== this.generation) return;
			void this.coordinator.runLatest(SYNTAX_DIAGNOSTIC_LANE, { languageId: this.model.getLanguageId() }, result => {
				if (result.value.lane !== SYNTAX_DIAGNOSTIC_LANE) throw new TypeError('Expected diagnostic result');
				this.results.accept({ ...result, value: result.value.value });
			}).catch(error => {
				if (!this.isDisposed && generation === this.generation) this.errors.fire(error);
			});
		});
	}
}

/** Fixed model-size limits used to keep expensive editor features bounded. */
export const TEXT_MODEL_LARGE_FILE_LIMITS = Object.freeze({
	tokenizationTextUnits: 20 * 1_024 * 1_024,
	tokenizationLineCount: 300_000,
	synchronizationTextUnits: 50 * 1_024 * 1_024,
	heapOperationTextUnits: 256 * 1_024 * 1_024,
});

export interface TextModelLargeFilePolicy {
	readonly tooLargeForTokenization: boolean;
	readonly tooLargeForSynchronization: boolean;
	readonly tooLargeForHeapOperation: boolean;
}

/** Classifies the initial model snapshot. The result deliberately remains stable for the model lifetime. */
export function classifyTextModelSize(textUnits: number, lineCount: number, largeFileOptimizations = true): TextModelLargeFilePolicy {
	if (!Number.isSafeInteger(textUnits) || textUnits < 0) throw new RangeError("Text model size must be a non-negative safe integer");
	if (!Number.isSafeInteger(lineCount) || lineCount < 1) throw new RangeError("Text model line count must be a positive safe integer");
	return Object.freeze({
		tooLargeForTokenization: largeFileOptimizations && (
			textUnits > TEXT_MODEL_LARGE_FILE_LIMITS.tokenizationTextUnits
			|| lineCount > TEXT_MODEL_LARGE_FILE_LIMITS.tokenizationLineCount
		),
		tooLargeForSynchronization: textUnits > TEXT_MODEL_LARGE_FILE_LIMITS.synchronizationTextUnits,
		tooLargeForHeapOperation: largeFileOptimizations && textUnits > TEXT_MODEL_LARGE_FILE_LIMITS.heapOperationTextUnits,
	});
}
