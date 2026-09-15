import { type CancellationToken } from '../../base/common/cancellation.js';
import { type Color } from '../../base/common/color.js';
import { type Event } from '../../base/common/event.js';
import { Disposable, type IDisposable } from '../../base/common/lifecycle.js';
import { type URI } from '../../base/common/uri.js';
import { EditOperation, type ISingleEditOperation } from './core/editOperation.js';
import { type Position } from './core/position.js';
import { type IRange, Range } from './core/range.js';
import { type TextSnapshot } from './core/textChange.js';
import { type LanguageId } from './encodedTokenAttributes.js';
import { type LanguageFeatureRequest } from './languages/languageFeatureRequest.js';
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
	readonly displayName?: string;
	provideDocumentFormattingEdits(model: model.ITextModel, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
}

export interface LanguageFormattingOptions extends Readonly<FormattingOptions> {
	readonly trimTrailingWhitespace?: boolean;
}

export interface LanguageFormattingRequest extends LanguageFeatureRequest {
	readonly resource?: URI;
	readonly range?: Range;
	readonly options: LanguageFormattingOptions;
	readonly position?: Position;
	readonly ch?: string;
}

export interface LanguageFormattingProvider {
	provideRangeFormattingEdits?(request: LanguageFormattingRequest, signal: AbortSignal): readonly TextEdit[] | Promise<readonly TextEdit[]>;
	provideOnTypeFormattingEdits?(request: LanguageFormattingRequest, signal: AbortSignal): readonly TextEdit[] | Promise<readonly TextEdit[]>;
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

export const TokenizationRegistry: ITokenizationRegistry<unknown> = new TokenizationRegistryImpl();
