import { type CancellationToken } from '../../base/common/cancellation.js';
import { type Color } from '../../base/common/color.js';
import { type Event } from '../../base/common/event.js';
import { Disposable, type IDisposable } from '../../base/common/lifecycle.js';
import { type URI } from '../../base/common/uri.js';
import { type ExtensionIdentifier } from '../../platform/extensions/common/extensions.js';
import { EditOperation, type ISingleEditOperation } from './core/editOperation.js';
import { type Position } from './core/position.js';
import { type IRange, Range } from './core/range.js';
import { type TextSnapshot } from './core/textChange.js';
import { type LanguageId } from './encodedTokenAttributes.js';
import { type LanguageSelector } from './languageSelector.js';
import * as model from './model.js';
import { type TextModel } from './model/textModel.js';
import { type LanguageTokenResult } from './tokens/languageTokens.js';
import { TokenizationRegistry as TokenizationRegistryImpl } from './tokenizationRegistry.js';

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
