import { type LanguageWorker } from './languages/languageRequestCoordinator.js';
import { type TextSnapshot, normalizeTextLineEndings } from './core/textChange.js';
import { Position } from './core/position.js';
import { Range, type IRange } from './core/range.js';
import { isPositiveSafeInteger } from '../../base/common/numbers.js';
import { type CancellationToken } from '../../base/common/cancellation.js';
import { type Color } from '../../base/common/color.js';
import { type Event } from '../../base/common/event.js';
import { Disposable, type IDisposable } from '../../base/common/lifecycle.js';
import { type URI } from '../../base/common/uri.js';
import { type ExtensionIdentifier } from '../../platform/extensions/common/extensions.js';
import { EditOperation, type ISingleEditOperation } from './core/editOperation.js';
import { type LanguageId } from './encodedTokenAttributes.js';
import { type LanguageSelector, assertLanguageSelector } from './languageSelector.js';
import * as model from './model.js';
import { type TextModel } from './model/textModel.js';
import { type LanguageTokenResult } from './tokens/languageTokens.js';
import { TokenizationRegistry as TokenizationRegistryImpl } from './tokenizationRegistry.js';
import { isNonEmptyArray } from '../../base/common/arrays.js';
import { assertLanguageId } from './languages/language.js';
import { type LanguageDiagnosticResult } from './languages/languageResults.js';
import { type LanguageWorkerDocumentSynchronization } from './services/textModelSync/textModelSync.protocol.js';

type Thenable<T> = PromiseLike<T>;

export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;

/** One source or target position returned by a cross-resource language feature. */
export interface LanguageLocation {
	readonly resource: URI;
	readonly range: Range;
	/** The narrower symbol-name range to select after opening the target. */
	readonly selectionRange?: Range;
}

export interface Command {
	id: string;
	title: string;
	tooltip?: string;
	arguments?: unknown[];
}

export namespace Command {
	export function is(value: unknown): value is Command {
		if (!value || typeof value !== 'object') return false;
		const command = value as Command;
		return typeof command.id === 'string' && typeof command.title === 'string';
	}
}

export interface CodeLens {
	range: IRange;
	id?: string;
	command?: Command;
}

export interface CodeLensList {
	readonly lenses: readonly CodeLens[];
	dispose?(): void;
}

export interface CodeLensProvider {
	onDidChange?: Event<this>;
	provideCodeLenses(model: model.ITextModel, token: CancellationToken): ProviderResult<CodeLensList>;
	resolveCodeLens?(model: model.ITextModel, codeLens: CodeLens, token: CancellationToken): ProviderResult<CodeLens>;
}

export interface LanguageSemanticTokensRequest {
	readonly requestId: number;
	readonly model: TextModel;
	readonly snapshot: TextSnapshot;
	readonly languageId: string;
	readonly resource?: URI;
}

export interface LanguageSemanticTokensProvider {
	provideSemanticTokens(request: LanguageSemanticTokensRequest, signal: AbortSignal): LanguageTokenResult | undefined | PromiseLike<LanguageTokenResult | undefined>;
}

/** @internal */
export interface ILanguageIdCodec {
	encodeLanguageId(languageId: string): LanguageId;
	decodeLanguageId(languageId: LanguageId): string;
}

export interface TextEdit {
	range: IRange;
	text: string;
	eol?: model.EndOfLineSequence;
}

/** Options supplied to document and range formatting providers. */
export interface FormattingOptions {
	tabSize: number;
	insertSpaces: boolean;
}

export interface DocumentFormattingEditProvider {
	readonly extensionId?: ExtensionIdentifier;
	readonly displayName?: string;
	provideDocumentFormattingEdits(model: model.ITextModel, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
}

export interface DocumentRangeFormattingEditProvider {
	readonly extensionId?: ExtensionIdentifier;
	readonly displayName?: string;
	provideDocumentRangeFormattingEdits(model: model.ITextModel, range: Range, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
	provideDocumentRangesFormattingEdits?(model: model.ITextModel, ranges: Range[], options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
}

export interface LanguageFormattingOptions extends Readonly<FormattingOptions> {
	readonly trimTrailingWhitespace?: boolean;
}

export interface OnTypeFormattingEditProvider {
	readonly extensionId?: ExtensionIdentifier;
	autoFormatTriggerCharacters: string[];
	provideOnTypeFormattingEdits(model: model.ITextModel, position: Position, ch: string, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
}

/** @internal */
export interface IInplaceReplaceSupportResult {
	value: string;
	range: IRange;
}

/** @internal */
export abstract class TextEdit {
	static asEditOperation(edit: TextEdit): ISingleEditOperation {
		const range = Range.lift(edit.range);
		return range.isEmpty()
			? EditOperation.insert(range.getStartPosition(), edit.text)
			: EditOperation.replace(range, edit.text);
	}

	static isTextEdit(thing: unknown): thing is TextEdit {
		const possibleTextEdit = thing as TextEdit;
		return typeof possibleTextEdit?.text === 'string' && Range.isIRange(possibleTextEdit.range);
	}
}

/** A color in RGBA format. */
export interface IColor {
	readonly red: number;
	readonly green: number;
	readonly blue: number;
	readonly alpha: number;
}

/** String representations for a color. */
export interface IColorPresentation {
	label: string;
	textEdit?: TextEdit;
	additionalTextEdits?: TextEdit[];
}

/** A color range in a text model. */
export interface IColorInformation {
	range: IRange;
	color: IColor;
}

/** A provider of colors for editor models. */
export interface DocumentColorProvider {
	provideDocumentColors(model: model.ITextModel, token: CancellationToken): ProviderResult<IColorInformation[]>;
	provideColorPresentations(model: model.ITextModel, colorInfo: IColorInformation, token: CancellationToken): ProviderResult<IColorPresentation[]>;
}

export enum DocumentHighlightKind {
	Text,
	Read,
	Write,
}

export interface DocumentHighlight {
	range: IRange;
	kind?: DocumentHighlightKind;
}

export interface MultiDocumentHighlight {
	uri: URI;
	highlights: DocumentHighlight[];
}

export interface DocumentHighlightProvider {
	provideDocumentHighlights(model: model.ITextModel, position: Position, token: CancellationToken): ProviderResult<DocumentHighlight[]>;
}

export interface MultiDocumentHighlightProvider {
	readonly selector: LanguageSelector;
	provideMultiDocumentHighlights(primaryModel: model.ITextModel, position: Position, otherModels: model.ITextModel[], token: CancellationToken): ProviderResult<Map<URI, DocumentHighlight[]>>;
}

export interface LinkedEditingRangeProvider {
	provideLinkedEditingRanges(model: model.ITextModel, position: Position, token: CancellationToken): ProviderResult<LinkedEditingRanges>;
}

export interface LinkedEditingRanges {
	ranges: IRange[];
	wordPattern?: RegExp;
}

/** @internal */
export class ProviderId {
	public static fromExtensionId(extensionId: string | undefined): ProviderId {
		return new ProviderId(extensionId, undefined, undefined);
	}

	constructor(
		public readonly extensionId: string | undefined,
		public readonly extensionVersion: string | undefined,
		public readonly providerId: string | undefined
	) {
	}

	toString(): string {
		let result = '';
		if (this.extensionId) {
			result += this.extensionId;
		}
		if (this.extensionVersion) {
			result += `@${this.extensionVersion}`;
		}
		if (this.providerId) {
			result += `:${this.providerId}`;
		}
		if (result.length === 0) {
			result = 'unknown';
		}
		return result;
	}

	toStringWithoutVersion(): string {
		let result = '';
		if (this.extensionId) {
			result += this.extensionId;
		}
		if (this.providerId) {
			result += `:${this.providerId}`;
		}
		return result;
	}
}

/** @internal */
export class VersionedExtensionId {
	public static tryCreate(extensionId: string | undefined, version: string | undefined): VersionedExtensionId | undefined {
		if (!extensionId || !version) {
			return undefined;
		}
		return new VersionedExtensionId(extensionId, version);
	}

	constructor(
		public readonly extensionId: string,
		public readonly version: string,
	) { }

	toString(): string {
		return `${this.extensionId}@${this.version}`;
	}
}

export interface ITokenizationSupportChangedEvent {
	readonly changedLanguages: string[];
	readonly changedColorMap: boolean;
}

export interface ILazyTokenizationSupport<TSupport> {
	readonly tokenizationSupport: Promise<TSupport | null>;
}

export class LazyTokenizationSupport<TSupport> extends Disposable implements ILazyTokenizationSupport<TSupport> {
	private support: Promise<TSupport & IDisposable | null> | undefined;

	constructor(private readonly createSupport: () => Promise<TSupport & IDisposable | null>) {
		super();
	}

	get tokenizationSupport(): Promise<TSupport | null> {
		this.support ??= this.createSupport();
		return this.support;
	}

	public override dispose(): void {
		void this.support?.then(support => support?.dispose());
		super.dispose();
	}
}

export interface ITokenizationRegistry<TSupport> {
	readonly onDidChange: Event<ITokenizationSupportChangedEvent>;
	handleChange(languageIds: string[]): void;
	register(languageId: string, support: TSupport): IDisposable;
	registerFactory(languageId: string, factory: ILazyTokenizationSupport<TSupport>): IDisposable;
	getOrCreate(languageId: string): Promise<TSupport | null>;
	get(languageId: string): TSupport | null;
	isResolved(languageId: string): boolean;
	setColorMap(colorMap: Color[]): void;
	getColorMap(): Color[] | null;
	getDefaultBackground(): Color | null;
}

export interface IState {
	clone(): IState;
	equals(other: IState): boolean;
}

export interface Token {
	readonly offset: number;
	readonly type: string;
	readonly language: string;
}

export interface TokenizationResult {
	readonly tokens: readonly Token[];
	readonly endState: IState;
}

export interface ITokenizationSupport {
	getInitialState(): IState;
	tokenize(line: string, hasEOL: boolean, state: IState): TokenizationResult;
}

export const TokenizationRegistry: ITokenizationRegistry<ITokenizationSupport> = new TokenizationRegistryImpl();

/** Common immutable request context passed to a language feature provider. */
export interface LanguageFeatureRequest {
	readonly model: TextModel;
	readonly snapshot: TextSnapshot;
	readonly languageId: string;
	readonly modelLanguageId: string;
	readonly signal: AbortSignal;
}

/** Creates a request from the model's current snapshot and a caller-owned cancellation signal. */
export function createLanguageFeatureRequest(model: TextModel, languageId: string, signal: AbortSignal): LanguageFeatureRequest {
	return Object.freeze({ model, snapshot: model.createVersionedSnapshot(), languageId, modelLanguageId: model.getLanguageId(), signal });
}

/** Returns whether a provider result may still be applied to the request's model. */
export function isLanguageFeatureRequestCurrent(request: LanguageFeatureRequest): boolean {
	return !request.signal.aborted
		&& !request.model.isDisposed()
		&& request.model.version === request.snapshot.version
		&& request.model.getLanguageId() === request.modelLanguageId;
}

/** Text replacements for one exact resource snapshot. */
export interface LanguageTextDocumentEdit {
	readonly kind: "textDocument";
	readonly resource: URI;
	/** Optional model version used to reject stale edits for an open document. */
	readonly version?: number;
	/** Optional exact content baseline used to reject stale closed or cross-process resources. */
	readonly expectedText?: string;
	readonly edits: readonly TextEdit[];
}

export type LanguageExistingTargetBehavior = "error" | "overwrite" | "ignore";
export type LanguageMissingTargetBehavior = "error" | "ignore";
export type LanguageDeleteMode = "fileOrEmptyDirectory" | "recursive";

export interface LanguageCreateFileEdit {
	readonly kind: "create";
	readonly resource: URI;
	readonly existing: LanguageExistingTargetBehavior;
}

export interface LanguageRenameFileEdit {
	readonly kind: "rename";
	readonly source: URI;
	readonly target: URI;
	readonly existing: LanguageExistingTargetBehavior;
}

export interface LanguageDeleteFileEdit {
	readonly kind: "delete";
	readonly resource: URI;
	readonly missing: LanguageMissingTargetBehavior;
	readonly mode: LanguageDeleteMode;
}

export type LanguageWorkspaceEditEntry = LanguageTextDocumentEdit | LanguageCreateFileEdit | LanguageRenameFileEdit | LanguageDeleteFileEdit;

/** One language-server edit spanning one or more text resources. */
export interface LanguageWorkspaceEdit {
	readonly entries: readonly LanguageWorkspaceEditEntry[];
}

export function normalizeLanguageWorkspaceEdit(edit: LanguageWorkspaceEdit): LanguageWorkspaceEdit {
	if (!edit || typeof edit !== "object" || !Array.isArray(edit.entries)) throw new TypeError("Language workspace edit must contain ordered entries");
	const entries = edit.entries.map(entry => {
		if (!entry || typeof entry !== "object") throw new TypeError("Language workspace edit entry must be an object");
		switch (entry.kind) {
			case "textDocument":
				if (!entry.resource || !Array.isArray(entry.edits)) throw new TypeError("Language document edit requires a resource and text edits");
				if (entry.version !== undefined && (!Number.isSafeInteger(entry.version) || entry.version < 1)) throw new RangeError("Language document edit version must be a positive safe integer");
				if (entry.expectedText !== undefined && typeof entry.expectedText !== "string") throw new TypeError("Language document edit expected text must be text");
				return Object.freeze({ kind: entry.kind, resource: entry.resource, ...(entry.version !== undefined ? { version: entry.version } : {}), ...(entry.expectedText !== undefined ? { expectedText: entry.expectedText } : {}), edits: Object.freeze([...entry.edits]) });
			case "create":
				return Object.freeze({ kind: entry.kind, resource: requireResource(entry.resource, "create target"), existing: existingBehavior(entry.existing) });
			case "rename":
				return Object.freeze({ kind: entry.kind, source: requireResource(entry.source, "rename source"), target: requireResource(entry.target, "rename target"), existing: existingBehavior(entry.existing) });
			case "delete":
				if (entry.missing !== "error" && entry.missing !== "ignore") throw new TypeError("Language delete missing-target behavior is invalid");
				if (entry.mode !== "fileOrEmptyDirectory" && entry.mode !== "recursive") throw new TypeError("Language delete mode is invalid");
				return Object.freeze({ kind: entry.kind, resource: requireResource(entry.resource, "delete target"), missing: entry.missing, mode: entry.mode });
			default:
				throw new TypeError("Language workspace edit entry kind is invalid");
		}
	});
	return Object.freeze({ entries: Object.freeze(entries) });
}

function requireResource(resource: URI, name: string): URI {
	if (!resource || typeof resource.toString !== "function") throw new TypeError(`Language workspace ${name} requires a resource`);
	return resource;
}

function existingBehavior(value: LanguageExistingTargetBehavior): LanguageExistingTargetBehavior {
	if (value !== "error" && value !== "overwrite" && value !== "ignore") throw new TypeError("Language workspace existing-target behavior is invalid");
	return value;
}

export enum LanguageCompletionTriggerKind {
	Invoke = "invoke",
	TriggerCharacter = "triggerCharacter",
	IncompleteRefresh = "incompleteRefresh",
}

export interface LanguageCompletionInvokeContext {
	readonly kind: LanguageCompletionTriggerKind.Invoke;
}

export interface LanguageCompletionTriggerCharacterContext {
	readonly kind: LanguageCompletionTriggerKind.TriggerCharacter;
	readonly triggerCharacter: string;
}

export interface LanguageCompletionIncompleteRefreshContext {
	readonly kind: LanguageCompletionTriggerKind.IncompleteRefresh;
}

export type LanguageCompletionContext = LanguageCompletionInvokeContext | LanguageCompletionTriggerCharacterContext | LanguageCompletionIncompleteRefreshContext;

export interface LanguageCompletionRequest {
	readonly languageId: string;
	readonly resource?: URI;
	readonly position: Position;
	readonly context: LanguageCompletionContext;
}

export interface LanguageCompletionProviderRequest extends LanguageCompletionRequest {
	readonly requestId: number;
	readonly snapshot: TextSnapshot;
}

export type LanguageCompletionProviderItem = Omit<LanguageCompletionItem, "providerId" | "hasDeferredDetails"> & {
	readonly resolveData?: unknown;
};

export interface LanguageCompletionProviderResolveRequest {
	readonly completionRequestId: number;
	readonly modelVersion: number;
	readonly item: LanguageCompletionProviderItem;
}

export interface LanguageCompletionProviderCommandRequest {
	readonly languageId: string;
	readonly resource?: URI;
	readonly snapshot: TextSnapshot;
	readonly command: LanguageCompletionCommand;
}

export interface LanguageCompletionProviderResult {
	readonly items: readonly LanguageCompletionProviderItem[];
	readonly isIncomplete: boolean;
}

export interface LanguageCompletionProvider {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly triggerCharacters?: readonly string[];
	provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined | PromiseLike<LanguageCompletionProviderResult | undefined>;
	resolveCompletionItem?(request: LanguageCompletionProviderResolveRequest, signal: AbortSignal): LanguageCompletionItemDetails | undefined | PromiseLike<LanguageCompletionItemDetails | undefined>;
	executeCompletionCommand?(request: LanguageCompletionProviderCommandRequest, signal: AbortSignal): void | PromiseLike<void>;
}

export interface LanguageCompletionProviderMetadata {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly triggerCharacters: readonly string[];
}

export interface LanguageCompletionProviderCatalog {
	readonly revision: number;
	readonly providers: readonly LanguageCompletionProviderMetadata[];
}

export interface LanguageCompletionProviderCatalogSource {
	readonly providerCatalog: LanguageCompletionProviderCatalog;
	readonly providerCatalogReady: boolean;
	readonly onDidChangeProviderCatalog: Event<LanguageCompletionProviderCatalog>;
	waitForProviderCatalog(): Promise<LanguageCompletionProviderCatalog>;
}

export interface RegisteredLanguageCompletionProvider extends LanguageCompletionProviderMetadata {
	provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined | PromiseLike<LanguageCompletionProviderResult | undefined>;
	resolveCompletionItem?(request: LanguageCompletionProviderResolveRequest, signal: AbortSignal): LanguageCompletionItemDetails | undefined | PromiseLike<LanguageCompletionItemDetails | undefined>;
	executeCompletionCommand?(request: LanguageCompletionProviderCommandRequest, signal: AbortSignal): void | PromiseLike<void>;
}

/** One caller-owned provider set that can be atomically replaced. */
export interface LanguageCompletionProviderRegistration extends IDisposable {
	replace(providers: readonly LanguageCompletionProvider[]): void;
}

export function createLanguageCompletionInvokeContext(): LanguageCompletionInvokeContext {
	return INVOKE_CONTEXT;
}

export function createLanguageCompletionTriggerCharacterContext(triggerCharacter: string): LanguageCompletionTriggerCharacterContext {
	assertTriggerCharacter(triggerCharacter);
	return Object.freeze({
		kind: LanguageCompletionTriggerKind.TriggerCharacter,
		triggerCharacter,
	});
}

export function createLanguageCompletionIncompleteRefreshContext(): LanguageCompletionIncompleteRefreshContext {
	return INCOMPLETE_REFRESH_CONTEXT;
}

export function assertLanguageCompletionRequest(request: LanguageCompletionRequest): void {
	if (typeof request !== "object" || request === null) {
		throw new TypeError("Language completion request must be an object");
	}
	assertLanguageId(request.languageId);
	if (request.resource !== undefined && typeof request.resource.toString !== "function") throw new TypeError("Language completion resource must be a URI");
	assertLanguageCompletionContext(request.context);
}

export function languageCompletionProviderMatches(provider: LanguageCompletionProviderMetadata, languageId: string, context: LanguageCompletionContext): boolean {
	assertProviderMetadata(provider);
	assertLanguageId(languageId);
	assertLanguageCompletionContext(context);
	return (
		provider.languageIds.includes("*") ||
		provider.languageIds.includes(languageId)
	) && (
		context.kind !== LanguageCompletionTriggerKind.TriggerCharacter ||
		provider.triggerCharacters.includes(context.triggerCharacter)
	);
}

export function normalizeLanguageCompletionProviderCatalog(value: unknown): LanguageCompletionProviderCatalog {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Language completion provider catalog must be an object");
	}
	const catalog = value as Partial<LanguageCompletionProviderCatalog>;
	if (!Number.isSafeInteger(catalog.revision) || catalog.revision! < 0) {
		throw new RangeError("Language completion provider catalog revision must be a non-negative safe integer");
	}
	if (!Array.isArray(catalog.providers)) {
		throw new TypeError("Language completion provider catalog must contain providers");
	}
	const identities = new Set<string>();
	const providers = catalog.providers.map(provider => {
		assertProviderMetadata(provider);
		if (identities.has(provider.id)) {
			throw new RangeError(`Duplicate language completion provider metadata '${provider.id}'`);
		}
		identities.add(provider.id);
		if (new Set(provider.languageIds).size !== provider.languageIds.length) {
			throw new RangeError(`Language completion provider '${provider.id}' language IDs must be unique`);
		}
		if (new Set(provider.triggerCharacters).size !== provider.triggerCharacters.length) {
			throw new RangeError(`Language completion provider '${provider.id}' trigger characters must be unique`);
		}
		return Object.freeze({
			id: provider.id,
			languageIds: Object.freeze([...provider.languageIds]),
			triggerCharacters: Object.freeze([...provider.triggerCharacters]),
		});
	});
	return Object.freeze({
		revision: catalog.revision!,
		providers: Object.freeze(providers),
	});
}

const INVOKE_CONTEXT = Object.freeze({
	kind: LanguageCompletionTriggerKind.Invoke,
});

const INCOMPLETE_REFRESH_CONTEXT = Object.freeze({
	kind: LanguageCompletionTriggerKind.IncompleteRefresh,
});

export function normalizeCompletionProvider(provider: LanguageCompletionProvider): RegisteredLanguageCompletionProvider {
	if (typeof provider !== "object" || provider === null) {
		throw new TypeError("Language completion provider must be an object");
	}
	assertLanguageProviderId(provider.id, "Language completion provider ID");
	if (!isNonEmptyArray(provider.languageIds)) {
		throw new TypeError("Language completion provider must declare language IDs");
	}
	const languageIds = provider.languageIds.map(languageId => {
		assertLanguageSelector(languageId);
		return languageId;
	});
	if (new Set(languageIds).size !== languageIds.length) {
		throw new RangeError("Language completion provider language IDs must be unique");
	}
	const triggerCharacters = [...(provider.triggerCharacters ?? [])];
	for (const character of triggerCharacters) assertTriggerCharacter(character);
	if (new Set(triggerCharacters).size !== triggerCharacters.length) {
		throw new RangeError("Language completion provider trigger characters must be unique");
	}
	if (typeof provider.provideCompletions !== "function") {
		throw new TypeError("Language completion provider must implement provideCompletions");
	}
	if (provider.resolveCompletionItem !== undefined && typeof provider.resolveCompletionItem !== "function") {
		throw new TypeError("Language completion provider resolveCompletionItem must be a function");
	}
	if (provider.executeCompletionCommand !== undefined && typeof provider.executeCompletionCommand !== "function") throw new TypeError("Language completion provider executeCompletionCommand must be a function");
	return Object.freeze({
		id: provider.id,
		languageIds: Object.freeze(languageIds),
		triggerCharacters: Object.freeze(triggerCharacters),
		provideCompletions: provider.provideCompletions.bind(provider),
		...(provider.resolveCompletionItem === undefined ? {} : { resolveCompletionItem: provider.resolveCompletionItem.bind(provider) }),
		...(provider.executeCompletionCommand === undefined ? {} : { executeCompletionCommand: provider.executeCompletionCommand.bind(provider) }),
	});
}

function assertProviderMetadata(provider: LanguageCompletionProviderMetadata): void {
	if (typeof provider !== "object" || provider === null) {
		throw new TypeError("Language completion provider metadata must be an object");
	}
	assertLanguageProviderId(provider.id, "Language completion provider ID");
	if (!isNonEmptyArray(provider.languageIds)) {
		throw new TypeError("Language completion provider metadata must declare language IDs");
	}
	for (const languageId of provider.languageIds) assertLanguageSelector(languageId);
	if (!Array.isArray(provider.triggerCharacters)) {
		throw new TypeError("Language completion provider metadata trigger characters must be an array");
	}
	for (const character of provider.triggerCharacters) assertTriggerCharacter(character);
}

export function assertLanguageCompletionContext(context: LanguageCompletionContext): void {
	if (typeof context !== "object" || context === null) {
		throw new TypeError("Language completion context must be an object");
	}
	if (context.kind === LanguageCompletionTriggerKind.TriggerCharacter) {
		assertTriggerCharacter(context.triggerCharacter);
		return;
	}
	if (
		context.kind !== LanguageCompletionTriggerKind.Invoke &&
		context.kind !== LanguageCompletionTriggerKind.IncompleteRefresh
	) {
		throw new TypeError(`Unknown language completion trigger kind '${(context as LanguageCompletionContext).kind}'`);
	}
}

export function assertLanguageProviderId(value: unknown, owner: string): asserts value is string {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
	) {
		throw new TypeError(`${owner} must contain only letters, digits, dot, underscore, or hyphen`);
	}
}

function assertTriggerCharacter(value: unknown): asserts value is string {
	if (typeof value !== "string" || [...value].length !== 1) {
		throw new TypeError("Language completion trigger character must contain one Unicode code point");
	}
}

export interface SyntaxRequest {
	readonly languageId: string;
}

export interface SyntaxProviderRequest extends SyntaxRequest {
	readonly requestId: number;
	readonly snapshot: TextSnapshot;
}

export interface SyntaxProvider {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly tokenPriority?: number;
	readonly diagnosticPriority?: number;
	provideTokens?(request: SyntaxProviderRequest, signal: AbortSignal): LanguageTokenResult | undefined | PromiseLike<LanguageTokenResult | undefined>;
	provideDiagnostics?(request: SyntaxProviderRequest, signal: AbortSignal): LanguageDiagnosticResult | undefined | PromiseLike<LanguageDiagnosticResult | undefined>;
	synchronizeDocument?(synchronization: LanguageWorkerDocumentSynchronization): void;
}

export interface RegisteredSyntaxProvider {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly tokenPriority: number;
	readonly diagnosticPriority: number;
	readonly provideTokens?: NonNullable<SyntaxProvider["provideTokens"]>;
	readonly provideDiagnostics?: NonNullable<SyntaxProvider["provideDiagnostics"]>;
	readonly synchronizeDocument?: NonNullable<SyntaxProvider["synchronizeDocument"]>;
}

export function assertSyntaxRequest(request: SyntaxRequest): void {
	if (typeof request !== "object" || request === null) {
		throw new TypeError("Syntax request must be an object");
	}
	assertLanguageId(request.languageId);
}

export function normalizeSyntaxProvider(provider: SyntaxProvider): RegisteredSyntaxProvider {
	if (typeof provider !== "object" || provider === null) {
		throw new TypeError("Syntax provider must be an object");
	}
	assertLanguageProviderId(provider.id, "Syntax provider ID");
	if (!isNonEmptyArray(provider.languageIds)) {
		throw new TypeError("Syntax provider must declare language IDs");
	}
	const languageIds = provider.languageIds.map(languageId => {
		assertLanguageSelector(languageId);
		return languageId;
	});
	if (new Set(languageIds).size !== languageIds.length) {
		throw new RangeError("Syntax provider language IDs must be unique");
	}
	if (provider.provideTokens !== undefined && typeof provider.provideTokens !== "function") {
		throw new TypeError("Syntax provider provideTokens must be a function");
	}
	if (provider.tokenPriority !== undefined && (!Number.isSafeInteger(provider.tokenPriority) || !provider.provideTokens)) {
		throw new TypeError("Syntax provider token priority requires a token provider and must be a safe integer");
	}
	if (provider.provideDiagnostics !== undefined && typeof provider.provideDiagnostics !== "function") {
		throw new TypeError("Syntax provider provideDiagnostics must be a function");
	}
	if (provider.diagnosticPriority !== undefined && (!Number.isSafeInteger(provider.diagnosticPriority) || !provider.provideDiagnostics)) {
		throw new TypeError("Syntax provider diagnostic priority requires a diagnostic provider and must be a safe integer");
	}
	if (provider.synchronizeDocument !== undefined && typeof provider.synchronizeDocument !== "function") {
		throw new TypeError("Syntax provider synchronizeDocument must be a function");
	}
	if (!provider.provideTokens && !provider.provideDiagnostics) {
		throw new TypeError("Syntax provider must implement tokens or diagnostics");
	}
	return Object.freeze({
		id: provider.id,
		languageIds: Object.freeze(languageIds),
		tokenPriority: provider.tokenPriority ?? 0,
		diagnosticPriority: provider.diagnosticPriority ?? 0,
		...(provider.provideTokens === undefined ? {} : { provideTokens: provider.provideTokens.bind(provider) }),
		...(provider.provideDiagnostics === undefined ? {} : { provideDiagnostics: provider.provideDiagnostics.bind(provider) }),
		...(provider.synchronizeDocument === undefined ? {} : { synchronizeDocument: provider.synchronizeDocument.bind(provider) }),
	});
}

export enum LanguageCompletionItemKind {
	Text = "text",
	Method = "method",
	Function = "function",
	Constructor = "constructor",
	Field = "field",
	Variable = "variable",
	Class = "class",
	Interface = "interface",
	Module = "module",
	Property = "property",
	Unit = "unit",
	Value = "value",
	Enum = "enum",
	Keyword = "keyword",
	Snippet = "snippet",
	File = "file",
	Folder = "folder",
	Reference = "reference",
	TypeParameter = "typeParameter",
}

/** Selects whether completion insertion text is literal text or snippet syntax. */
export enum LanguageCompletionInsertTextFormat {
	PlainText = "plainText",
	Snippet = "snippet",
}

export interface LanguageCompletionItem {
	readonly providerId: string;
	readonly id: string;
	readonly label: string;
	readonly kind: LanguageCompletionItemKind;
	readonly range: Range;
	readonly insertText: string;
	readonly insertTextFormat?: LanguageCompletionInsertTextFormat;
	readonly detail?: string;
	readonly documentation?: string;
	readonly filterText?: string;
	readonly sortText?: string;
	readonly preselect?: boolean;
	/** Characters that atomically accept this item before being inserted. */
	readonly commitCharacters?: readonly string[];
	/** Additional non-overlapping edits applied with the primary completion replacement. */
	readonly additionalTextEdits?: readonly LanguageCompletionTextEdit[];
	/** Server command executed after this candidate has been inserted. */
	readonly command?: LanguageCompletionCommand;
	readonly hasDeferredDetails?: boolean;
}

/** One completion-owned server command. */
export interface LanguageCompletionCommand {
	readonly id: string;
	readonly title: string;
	readonly arguments: readonly unknown[];
}

/** One extra document replacement attached to a completion item. */
export interface LanguageCompletionTextEdit {
	readonly range: Range;
	readonly text: string;
}

export interface LanguageCompletionResult {
	readonly position: Position;
	readonly items: readonly LanguageCompletionItem[];
	readonly isIncomplete: boolean;
}

export interface LanguageCompletionItemDetails {
	readonly detail?: string;
	readonly documentation?: string;
}

export interface LanguageCompletionResolveRequest {
	readonly completionRequestId: number;
	readonly modelVersion: number;
	readonly providerId: string;
	readonly itemId: string;
}

export interface LanguageCompletionItemResolver {
	resolveCompletionItem(request: LanguageCompletionResolveRequest, signal: AbortSignal): Promise<LanguageCompletionItemDetails>;
}

export type LanguageCompletionResultNormalizer = (value: LanguageCompletionResult) => LanguageCompletionResult;

export const LANGUAGE_COMPLETION_LANE = "completion";

export type LanguageCompletionLane = typeof LANGUAGE_COMPLETION_LANE;

export type LanguageCompletionWorker = LanguageWorker<LanguageCompletionLane, LanguageCompletionRequest, LanguageCompletionResult>;

export type LanguageCompletionWorkerFactory = () => LanguageCompletionWorker;

/** Validates provider output against an immutable captured model snapshot. */
export function normalizeLanguageCompletionSnapshotResult(value: LanguageCompletionResult, snapshot: TextSnapshot): LanguageCompletionResult {
	return createLanguageCompletionSnapshotNormalizer(snapshot)(value);
}

/** Builds one reusable normalizer so all providers in a request share the same snapshot line index. */
export function createLanguageCompletionSnapshotNormalizer(snapshot: TextSnapshot): LanguageCompletionResultNormalizer {
	const lines = snapshot.getText().split("\n");
	return value => normalizeLanguageCompletionResult(
		value,
		position => assertSnapshotPosition(lines, position),
		(position, range) => assertSnapshotCompletionRange(lines, position, range),
		range => assertSnapshotTextEditRange(lines, range),
	);
}

export function normalizeLanguageCompletionItemDetails(value: unknown): LanguageCompletionItemDetails {
	if (value === undefined) return EMPTY_DETAILS;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Language completion item details must be an object");
	}
	const details = value as Record<string, unknown>;
	for (const key of Object.keys(details)) {
		if (key !== "detail" && key !== "documentation") {
			throw new TypeError(`Language completion item details contain unsupported field '${key}'`);
		}
	}
	assertOptionalText(details.detail as string | undefined, "Language completion item detail");
	assertOptionalText(details.documentation as string | undefined, "Language completion item documentation");
	return Object.freeze({
		...(details.detail === undefined ? {} : { detail: details.detail as string }),
		...(details.documentation === undefined ? {} : { documentation: details.documentation as string }),
	});
}

export function normalizeLanguageCompletionResolveRequest(value: LanguageCompletionResolveRequest): LanguageCompletionResolveRequest {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Language completion resolve request must be an object");
	}
	assertPositiveSafeInteger(value.completionRequestId, "Language completion request ID");
	assertPositiveSafeInteger(value.modelVersion, "Language completion model version");
	assertIdentifier(value.providerId, "Language completion provider ID");
	assertIdentifier(value.itemId, "Language completion item ID");
	return Object.freeze({
		completionRequestId: value.completionRequestId,
		modelVersion: value.modelVersion,
		providerId: value.providerId,
		itemId: value.itemId,
	});
}

export function normalizeLanguageCompletionResult(
	value: LanguageCompletionResult,
	validatePosition: (position: Position) => void,
	validateRange: (position: Position, range: Range) => void,
	validateAdditionalRange: (range: Range) => void,
): LanguageCompletionResult {
	if (typeof value !== "object" || value === null || !Array.isArray(value.items)) {
		throw new TypeError("Language completion result must contain an items array");
	}
	if (!(value.position instanceof Position)) {
		throw new TypeError("Language completion position must be a Position");
	}
	validatePosition(value.position);
	if (typeof value.isIncomplete !== "boolean") {
		throw new TypeError("Language completion isIncomplete must be a boolean");
	}
	const identities = new Set<string>();
	let preselectSeen = false;
	const items = value.items.map(item => {
		if (typeof item !== "object" || item === null) {
			throw new TypeError("Language completion item must be an object");
		}
		assertIdentifier(item.providerId, "Language completion provider ID");
		assertIdentifier(item.id, "Language completion item ID");
		const identity = `${item.providerId}\0${item.id}`;
		if (identities.has(identity)) {
			throw new RangeError(`Duplicate language completion item identity '${item.providerId}/${item.id}'`);
		}
		identities.add(identity);
		assertNonEmptyText(item.label, "Language completion item label");
		if (!Object.values(LanguageCompletionItemKind).includes(item.kind)) {
			throw new TypeError(`Unknown language completion item kind '${item.kind}'`);
		}
		validateRange(value.position, item.range);
		if (typeof item.insertText !== "string") {
			throw new TypeError("Language completion insertText must be a string");
		}
		if (item.insertTextFormat !== undefined && !Object.values(LanguageCompletionInsertTextFormat).includes(item.insertTextFormat)) {
			throw new TypeError(`Unknown language completion insert text format '${item.insertTextFormat}'`);
		}
		assertOptionalText(item.detail, "Language completion item detail");
		assertOptionalText(item.documentation, "Language completion item documentation");
		assertOptionalText(item.filterText, "Language completion item filterText");
		assertOptionalText(item.sortText, "Language completion item sortText");
		if (item.preselect !== undefined && typeof item.preselect !== "boolean") {
			throw new TypeError("Language completion item preselect must be a boolean");
		}
		const commitCharacters = normalizeCommitCharacters(item.commitCharacters);
		const additionalTextEdits = normalizeAdditionalTextEdits(
			item.additionalTextEdits,
			item.range,
			validateAdditionalRange,
		);
		const command = normalizeCompletionCommand(item.command);
		if (item.hasDeferredDetails !== undefined && typeof item.hasDeferredDetails !== "boolean") {
			throw new TypeError("Language completion item hasDeferredDetails must be a boolean");
		}
		if (item.preselect) {
			if (preselectSeen) {
				throw new RangeError("Language completion result must not preselect multiple items");
			}
			preselectSeen = true;
		}
		return Object.freeze({
			providerId: item.providerId,
			id: item.id,
			label: item.label,
			kind: item.kind,
			range: item.range,
			insertText: normalizeTextLineEndings(item.insertText),
			...(item.insertTextFormat === undefined ? {} : { insertTextFormat: item.insertTextFormat }),
			...(item.detail === undefined ? {} : { detail: item.detail }),
			...(item.documentation === undefined ? {} : { documentation: item.documentation }),
			...(item.filterText === undefined ? {} : { filterText: item.filterText }),
			...(item.sortText === undefined ? {} : { sortText: item.sortText }),
			...(item.preselect === undefined ? {} : { preselect: item.preselect }),
			...(commitCharacters === undefined ? {} : { commitCharacters }),
			...(additionalTextEdits === undefined ? {} : { additionalTextEdits }),
			...(command === undefined ? {} : { command }),
			...(item.hasDeferredDetails === undefined ? {} : { hasDeferredDetails: item.hasDeferredDetails }),
		});
	});
	return Object.freeze({
		position: value.position,
		items: Object.freeze(items),
		isIncomplete: value.isIncomplete,
	});
}

function normalizeCompletionCommand(value: unknown): LanguageCompletionCommand | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Language completion command must be an object");
	const command = value as Record<string, unknown>;
	if (Object.keys(command).some(key => key !== "id" && key !== "title" && key !== "arguments")) throw new TypeError("Language completion command contains unsupported fields");
	assertIdentifier(command.id, "Language completion command ID");
	assertNonEmptyText(command.title, "Language completion command title");
	if (!Array.isArray(command.arguments)) throw new TypeError("Language completion command arguments must be an array");
	return Object.freeze({ id: command.id, title: command.title, arguments: Object.freeze(structuredClone(command.arguments)) });
}

const EMPTY_DETAILS: LanguageCompletionItemDetails = Object.freeze({});

function assertSnapshotCompletionRange(lines: readonly string[], position: Position, range: Range): void {
	if (!(range instanceof Range)) {
		throw new TypeError("Language completion item range must be a Range");
	}
	assertSnapshotPosition(lines, range.getStartPosition());
	assertSnapshotPosition(lines, range.getEndPosition());
	if (
		range.getStartPosition().lineNumber !== position.lineNumber ||
		range.getEndPosition().lineNumber !== position.lineNumber
	) {
		throw new RangeError("Language completion item range must stay on the trigger line");
	}
	if (Position.compare(range.getStartPosition(), position) > 0 || Position.compare(range.getEndPosition(), position) < 0) {
		throw new RangeError("Language completion item range must contain the trigger position");
	}
}

function assertSnapshotTextEditRange(lines: readonly string[], range: Range): void {
	if (!(range instanceof Range)) {
		throw new TypeError("Language completion additional edit range must be a Range");
	}
	assertSnapshotPosition(lines, range.getStartPosition());
	assertSnapshotPosition(lines, range.getEndPosition());
}

function assertSnapshotPosition(lines: readonly string[], position: Position): void {
	if (!(position instanceof Position)) {
		throw new TypeError("Language completion position must be a Position");
	}
	if (
		position.lineNumber < 1 ||
		position.lineNumber > lines.length ||
		position.column < 1 ||
		position.column > lines[position.lineNumber - 1]!.length + 1
	) {
		throw new RangeError("Language completion position is outside its snapshot");
	}
}

function assertOptionalText(value: string | undefined, owner: string): void {
	if (value !== undefined) assertNonEmptyText(value, owner);
}

/** Validates one completion commit character using the same grapheme contract as browser input. */
export function assertLanguageCompletionCommitCharacter(value: unknown): asserts value is string {
	if (typeof value !== "string" || value === "\n" || value === "\r" || [...value].length !== 1) {
		throw new TypeError("Language completion commit character must be one non-line-break grapheme");
	}
}

function normalizeCommitCharacters(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new TypeError("Language completion commit characters must be an array");
	const characters = value.map(character => {
		assertLanguageCompletionCommitCharacter(character);
		return character;
	});
	if (new Set(characters).size !== characters.length) {
		throw new RangeError("Language completion commit characters must be unique");
	}
	return Object.freeze(characters);
}

function normalizeAdditionalTextEdits(value: unknown, primaryRange: Range, validateRange: (range: Range) => void): readonly LanguageCompletionTextEdit[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new TypeError("Language completion additional text edits must be an array");
	const edits = value.map(edit => {
		if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
			throw new TypeError("Language completion additional text edit must be an object");
		}
		const record = edit as Record<string, unknown>;
		if (Object.keys(record).some(key => key !== "range" && key !== "text")) {
			throw new TypeError("Language completion additional text edit contains unsupported fields");
		}
		if (!(record.range instanceof Range)) {
			throw new TypeError("Language completion additional edit range must be a Range");
		}
		validateRange(record.range);
		if (typeof record.text !== "string") {
			throw new TypeError("Language completion additional edit text must be a string");
		}
		return Object.freeze({ range: record.range, text: normalizeTextLineEndings(record.text) });
	});
	assertNonOverlappingCompletionEditRanges(primaryRange, edits);
	return Object.freeze(edits);
}

function assertNonOverlappingCompletionEditRanges(primaryRange: Range, edits: readonly LanguageCompletionTextEdit[]): void {
	const ranges = [primaryRange, ...edits.map(edit => edit.range)].sort((left, right) =>
		Position.compare(left.getStartPosition(), right.getStartPosition()) || Position.compare(left.getEndPosition(), right.getEndPosition())
	);
	for (let index = 1; index < ranges.length; index += 1) {
		const previous = ranges[index - 1]!;
		const current = ranges[index]!;
		if (Position.compare(current.getStartPosition(), previous.getEndPosition()) <= 0) {
			throw new RangeError("Language completion primary and additional edit ranges must not overlap or touch");
		}
	}
}

function assertIdentifier(value: unknown, owner: string): asserts value is string {
	assertNonEmptyText(value, owner);
	if (value.trim() !== value) {
		throw new TypeError(`${owner} must be trimmed`);
	}
}

function assertNonEmptyText(value: unknown, owner: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${owner} must not be empty`);
	}
}

function assertPositiveSafeInteger(value: unknown, owner: string): asserts value is number {
	if (!isPositiveSafeInteger(value)) {
		throw new RangeError(`${owner} must be a positive safe integer`);
	}
}

export type LanguageWorkspaceSymbolKind = string | number;

export interface LanguageWorkspaceSymbol {
	readonly name: string;
	readonly kind: LanguageWorkspaceSymbolKind;
	readonly resource: URI;
	readonly range: Range;
	readonly containerName?: string;
	readonly data?: unknown;
}

export interface LanguageWorkspaceSymbolProvider {
	provideWorkspaceSymbols(query: string, signal: AbortSignal): readonly LanguageWorkspaceSymbol[] | Promise<readonly LanguageWorkspaceSymbol[]>;
	resolveWorkspaceSymbol?(symbol: LanguageWorkspaceSymbol, signal: AbortSignal): LanguageWorkspaceSymbol | Promise<LanguageWorkspaceSymbol>;
}
