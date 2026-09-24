import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { type URI } from '../../../base/common/uri.js';
import type { TextResourceLanguageInput } from '../../../platform/language/common/textResourceLanguage.js';
import { LanguagesRegistry, type LanguageDescription, type LanguageDescriptionContribution, type LanguageDescriptionRegistration, type LanguageRegistrationOptions } from './languagesRegistry.js';
import { type ILanguageIdCodec } from '../languages.js';
import { LanguageId } from '../encodedTokenAttributes.js';
import { type ILanguageExtensionPoint, type ILanguageIcon, type ILanguageNameIdPair, type ILanguageSelection, type IAshLanguageService } from '../languages/language.js';

/** Owns language identities and file associations independently of feature providers. */
export class LanguageService extends Disposable implements IAshLanguageService {
	public static instanceCount = 0;

	readonly _serviceBrand = undefined;
	public readonly languages = this._register(new LanguagesRegistry());
	private readonly basicFeaturesEmitter = this._register(new Emitter<string>());
	private readonly richFeaturesEmitter = this._register(new Emitter<string>());
	private readonly requestedBasic = new Set<string>();
	private readonly requestedRich = new Set<string>();
	readonly languageIdCodec: ILanguageIdCodec = new LanguageIdCodec();
	readonly onDidRequestBasicLanguageFeatures = this.basicFeaturesEmitter.event;
	readonly onDidRequestRichLanguageFeatures = this.richFeaturesEmitter.event;
	readonly onDidChange: Event<void> = listener => this.languages.onDidChange(() => listener());

	constructor(private readonly warnOnOverwrite = false) {
		super();
		LanguageService.instanceCount += 1;
		this._register(this.languages.register({ id: 'plaintext', extensions: ['.txt'], mimetypes: ['text/plain'] }));
	}

	public registerLanguage(definition: ILanguageExtensionPoint): IDisposable;
	public registerLanguage(description: LanguageDescription, options?: LanguageRegistrationOptions): IDisposable;
	public registerLanguage(description: LanguageDescription, options: LanguageRegistrationOptions = {}): IDisposable {
		if (this.warnOnOverwrite && this.languages.get(description.id)) {
			console.warn(`Overwriting language contribution '${description.id}'`);
		}
		this.languageIdCodec.encodeLanguageId(description.id);
		return this.languages.register(description, options);
	}

	public registerLanguages(contributions: readonly LanguageDescriptionContribution[]): LanguageDescriptionRegistration {
		if (this.warnOnOverwrite) {
			for (const contribution of contributions) {
				if (this.languages.get(contribution.description.id)) console.warn(`Overwriting language contribution '${contribution.description.id}'`);
			}
		}
		for (const contribution of contributions) this.languageIdCodec.encodeLanguageId(contribution.description.id);
		return this.languages.registerMany(contributions);
	}

	public resolveLanguageId(input: TextResourceLanguageInput): string | undefined {
		return this.languages.resolveLanguageId(input);
	}

	isRegisteredLanguageId(languageId: string | null | undefined): boolean { return languageId !== null && languageId !== undefined && this.languages.get(languageId) !== undefined; }
	getRegisteredLanguageIds(): string[] { return this.languages.getRegisteredLanguageIds(); }
	getSortedRegisteredLanguageNames(): ILanguageNameIdPair[] { return this.languages.getSortedRegisteredLanguageNames(); }
	getLanguageName(languageId: string): string | null { return this.languages.getLanguageName(languageId); }
	getMimeType(languageId: string): string | null { return this.languages.get(languageId)?.mimetypes?.[0] ?? null; }
	getIcon(languageId: string): ILanguageIcon | null { return this.languages.get(languageId)?.icon ?? null; }
	getExtensions(languageId: string): ReadonlyArray<string> { return this.languages.get(languageId)?.extensions ?? []; }
	getFilenames(languageId: string): ReadonlyArray<string> { return this.languages.get(languageId)?.filenames ?? []; }
	getConfigurationFiles(languageId: string): ReadonlyArray<URI> {
		const configuration = this.languages.get(languageId)?.configuration;
		return configuration ? [configuration] : [];
	}
	getLanguageIdByLanguageName(languageName: string): string | null { return this.languages.getLanguageIdByLanguageName(languageName); }
	getLanguageIdByMimeType(mimeType: string | null | undefined): string | null { return this.languages.getLanguageIdByMimeType(mimeType); }
	guessLanguageIdByFilepathOrFirstLine(resource: URI | null, firstLine?: string): string | null { return resource ? this.resolveLanguageId({ resource, firstLine }) ?? null : null; }
	createById(languageId: string | null | undefined): ILanguageSelection {
		return new LanguageSelection(this.onDidChange, () => languageId && this.isRegisteredLanguageId(languageId) ? languageId : 'plaintext');
	}
	createByMimeType(mimeType: string | null | undefined): ILanguageSelection {
		return new LanguageSelection(this.onDidChange, () => this.getLanguageIdByMimeType(mimeType) ?? 'plaintext');
	}
	createByFilepathOrFirstLine(resource: URI | null, firstLine?: string): ILanguageSelection {
		return new LanguageSelection(this.onDidChange, () => this.guessLanguageIdByFilepathOrFirstLine(resource, firstLine) ?? 'plaintext');
	}

	requestBasicLanguageFeatures(languageId: string): void {
		if (this.requestedBasic.has(languageId)) return;
		this.requestedBasic.add(languageId);
		this.basicFeaturesEmitter.fire(languageId);
	}

	requestRichLanguageFeatures(languageId: string): void {
		this.requestBasicLanguageFeatures(languageId);
		if (this.requestedRich.has(languageId)) return;
		this.requestedRich.add(languageId);
		this.richFeaturesEmitter.fire(languageId);
	}

	protected override disposeCore(): void {
		LanguageService.instanceCount -= 1;
		super.disposeCore();
	}
}

class LanguageIdCodec implements ILanguageIdCodec {
	private readonly ids = new Map<string, LanguageId>([['plaintext', LanguageId.PlainText]]);
	private readonly languages = new Map<LanguageId, string>([[LanguageId.PlainText, 'plaintext']]);

	encodeLanguageId(languageId: string): LanguageId {
		const existing = this.ids.get(languageId);
		if (existing !== undefined) return existing;
		const id = this.ids.size + 1;
		this.ids.set(languageId, id);
		this.languages.set(id, languageId);
		return id;
	}

	decodeLanguageId(languageId: LanguageId): string { return this.languages.get(languageId) ?? 'plaintext'; }
}

class LanguageSelection implements ILanguageSelection {
	readonly onDidChange: Event<string>;

	constructor(onDidChangeLanguages: Event<void>, private readonly selector: () => string) {
		this.onDidChange = (listener, thisArgs, disposables) => {
			let previous = this.selector();
			return onDidChangeLanguages(() => {
				const current = this.selector();
				if (current === previous) return;
				previous = current;
				listener.call(thisArgs, current);
			}, undefined, disposables);
		};
	}

	get languageId(): string {
		return this.selector();
	}
}
