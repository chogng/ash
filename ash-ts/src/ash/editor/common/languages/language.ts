import { type Event } from '../../../base/common/event.js';
import { type IDisposable } from '../../../base/common/lifecycle.js';
import { type URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { type TextResourceLanguageInput } from '../../../platform/language/common/textResourceLanguage.js';
import { type ILanguageIdCodec } from '../languages.js';
import { type LanguageDescription, type LanguageDescriptionContribution, type LanguageDescriptionRegistration, type LanguageRegistrationOptions, type LanguagesRegistry } from '../services/languagesRegistry.js';

export const ILanguageService = createServiceIdentifier<IAshLanguageService>('languageService');

export interface ILanguageExtensionPoint {
	id: string;
	extensions?: string[];
	filenames?: string[];
	filenamePatterns?: string[];
	firstLine?: string;
	aliases?: string[];
	mimetypes?: string[];
	configuration?: URI;
	icon?: ILanguageIcon;
}

export interface ILanguageSelection {
	readonly languageId: string;
	readonly onDidChange: Event<string>;
}

export interface ILanguageNameIdPair {
	readonly languageName: string;
	readonly languageId: string;
}

export interface ILanguageIcon {
	readonly light: URI;
	readonly dark: URI;
}

export interface ILanguageService {
	readonly _serviceBrand: undefined;
	readonly languageIdCodec: ILanguageIdCodec;
	readonly onDidRequestBasicLanguageFeatures: Event<string>;
	readonly onDidRequestRichLanguageFeatures: Event<string>;
	readonly onDidChange: Event<void>;
	registerLanguage(definition: ILanguageExtensionPoint): IDisposable;
	isRegisteredLanguageId(languageId: string | null | undefined): boolean;
	getRegisteredLanguageIds(): string[];
	getSortedRegisteredLanguageNames(): ILanguageNameIdPair[];
	getLanguageName(languageId: string): string | null;
	getMimeType(languageId: string): string | null;
	getIcon(languageId: string): ILanguageIcon | null;
	getExtensions(languageId: string): ReadonlyArray<string>;
	getFilenames(languageId: string): ReadonlyArray<string>;
	getConfigurationFiles(languageId: string): ReadonlyArray<URI>;
	getLanguageIdByLanguageName(languageName: string): string | null;
	getLanguageIdByMimeType(mimeType: string | null | undefined): string | null;
	guessLanguageIdByFilepathOrFirstLine(resource: URI | null, firstLine?: string): string | null;
	createById(languageId: string | null | undefined): ILanguageSelection;
	createByMimeType(mimeType: string | null | undefined): ILanguageSelection;
	createByFilepathOrFirstLine(resource: URI | null, firstLine?: string): ILanguageSelection;
	requestBasicLanguageFeatures(languageId: string): void;
	requestRichLanguageFeatures(languageId: string): void;
}

/** Ash-owned language contribution operations layered on the VS Code contract. */
export interface IAshLanguageService extends ILanguageService, IDisposable {
	readonly languages: LanguagesRegistry;
	registerLanguage(description: LanguageDescription, options?: LanguageRegistrationOptions): IDisposable;
	registerLanguages(contributions: readonly LanguageDescriptionContribution[]): LanguageDescriptionRegistration;
	resolveLanguageId(input: TextResourceLanguageInput): string | undefined;
}

const LANGUAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validates one concrete editor language identity. */
export function assertLanguageId(value: unknown): asserts value is string {
	if (typeof value !== "string" || !LANGUAGE_ID_PATTERN.test(value)) {
		throw new TypeError("Language ID must contain only letters, digits, dot, underscore, or hyphen");
	}
}
