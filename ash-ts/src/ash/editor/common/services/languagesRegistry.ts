import { CharCode } from "../../../base/common/charCode.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { escapeRegExpCharacters } from "../../../base/common/strings.js";
import { assertLanguageId, type ILanguageIcon, type ILanguageNameIdPair } from '../languages/language.js';
import type { TextResourceLanguageInput } from "../../../platform/language/common/textResourceLanguage.js";
import { type URI } from '../../../base/common/uri.js';

/** Declarative identity and file-association metadata for one editor language. */
export interface LanguageDescription {
	readonly id: string;
	readonly aliases?: readonly string[];
	readonly extensions?: readonly string[];
	readonly filenames?: readonly string[];
	readonly filenamePatterns?: readonly string[];
	readonly mimetypes?: readonly string[];
	readonly firstLine?: string;
	readonly configuration?: URI;
	readonly icon?: ILanguageIcon;
}

export interface LanguageRegistrationOptions {
	readonly priority?: number;
}

export interface LanguageDescriptionChangeEvent {
	readonly languageId: string;
}

export interface LanguageDescriptionContribution {
	readonly description: LanguageDescription;
	readonly options?: LanguageRegistrationOptions;
}

/** One caller-owned set of language descriptions that can be replaced without self-conflicts. */
export interface LanguageDescriptionRegistration extends IDisposable {
	replace(contributions: readonly LanguageDescriptionContribution[]): void;
}

interface RegisteredLanguageDescription {
	readonly owner: object;
	readonly description: LanguageDescription;
	readonly firstLinePattern?: RegExp;
	readonly priority: number;
	readonly order: number;
}

/** Resolves declarative language associations without owning extension resources. */
export class LanguagesRegistry extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<LanguageDescriptionChangeEvent>());
	private readonly descriptions = new Map<string, RegisteredLanguageDescription[]>();
	private nextOrder = 1;

	readonly onDidChange: Event<LanguageDescriptionChangeEvent> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.descriptions.clear();
		}));
	}

	register(description: LanguageDescription, options: LanguageRegistrationOptions = {}): IDisposable {
		return this.registerMany([{ description, options }]);
	}

	registerMany(contributions: readonly LanguageDescriptionContribution[]): LanguageDescriptionRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replace(owner, contributions);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			this.removeOwner(owner);
		}) as LanguageDescriptionRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Language description registration is already disposed");
			this.assertNotDisposed();
			this.replace(owner, replacement);
		};
		return registration;
	}

	get(languageId: string): LanguageDescription | undefined {
		this.assertNotDisposed();
		assertLanguageId(languageId);
		return selectDescription(this.descriptions.get(languageId))?.description;
	}

	getRegisteredLanguageIds(): string[] {
		this.assertNotDisposed();
		return [...this.descriptions.keys()];
	}

	getSortedRegisteredLanguageNames(): ILanguageNameIdPair[] {
		return this.getRegisteredLanguageIds().flatMap(languageId => {
			const name = this.getLanguageName(languageId);
			return name === null ? [] : [{ languageId, languageName: name }];
		}).sort((left, right) => left.languageName.localeCompare(right.languageName, undefined, { sensitivity: 'base' }));
	}

	getLanguageName(languageId: string): string | null {
		const description = this.get(languageId);
		return description?.aliases?.[0] ?? description?.id ?? null;
	}

	getLanguageIdByLanguageName(languageName: string): string | null {
		const normalized = languageName.toLocaleLowerCase();
		return this.getRegisteredLanguageIds().find(languageId => this.get(languageId)?.aliases?.some(alias => alias.toLocaleLowerCase() === normalized)) ?? null;
	}

	getLanguageIdByMimeType(mimeType: string | null | undefined): string | null {
		if (!mimeType) return null;
		const normalized = mimeType.toLocaleLowerCase();
		return this.getRegisteredLanguageIds().find(languageId => this.get(languageId)?.mimetypes?.includes(normalized)) ?? null;
	}

	resolveLanguageId(input: TextResourceLanguageInput): string | undefined {
		this.assertNotDisposed();
		if (!input || typeof input !== "object") throw new TypeError("Language resolution input is required");
		const path = normalizePath(input.resource.path);
		const fileName = path.slice(path.lastIndexOf("/") + 1);
		const contentType = input.contentType?.toLowerCase();
		const firstLine = normalizeFirstLineText(input.firstLine);
		let best: LanguageMatch | undefined;
		for (const entries of this.descriptions.values()) {
			for (const entry of entries) {
				const match = matchDescription(entry, path, fileName, contentType, firstLine);
				if (match && (!best || compareMatches(match, best) > 0)) best = match;
			}
		}
		return best?.languageId;
	}


	private replace(owner: object, contributions: readonly LanguageDescriptionContribution[]): void {
		if (!Array.isArray(contributions)) throw new TypeError("Language description contributions must be an array");
		const entries = contributions.map(contribution => {
			if (typeof contribution !== "object" || contribution === null) throw new TypeError("Language description contribution must be an object");
			const description = normalizeDescription(contribution.description);
			return Object.freeze({ owner, description, ...(description.firstLine === undefined ? {} : { firstLinePattern: new RegExp(description.firstLine) }), priority: normalizePriority(contribution.options ?? {}), order: this.nextOrder++ });
		});
		const affected = this.ownerLanguageIds(owner);
		for (const entry of entries) affected.add(entry.description.id);
		this.deleteOwner(owner);
		for (const entry of entries) {
			const values = this.descriptions.get(entry.description.id);
			if (values) values.push(entry);
			else this.descriptions.set(entry.description.id, [entry]);
		}
		for (const languageId of [...affected].sort()) this.changeEmitter.fire(Object.freeze({ languageId }));
	}

	private removeOwner(owner: object): void {
		const affected = this.ownerLanguageIds(owner);
		this.deleteOwner(owner);
		if (!this.isDisposed) for (const languageId of [...affected].sort()) this.changeEmitter.fire(Object.freeze({ languageId }));
	}

	private deleteOwner(owner: object): void {
		for (const [languageId, entries] of this.descriptions) {
			const remaining = entries.filter(entry => entry.owner !== owner);
			if (remaining.length === 0) this.descriptions.delete(languageId);
			else if (remaining.length !== entries.length) this.descriptions.set(languageId, remaining);
		}
	}

	private ownerLanguageIds(owner: object): Set<string> {
		const languageIds = new Set<string>();
		for (const [languageId, entries] of this.descriptions) if (entries.some(entry => entry.owner === owner)) languageIds.add(languageId);
		return languageIds;
	}
}

interface LanguageMatch {
	readonly languageId: string;
	readonly priority: number;
	readonly rank: number;
	readonly specificity: number;
	readonly order: number;
}

function normalizeDescription(description: LanguageDescription): LanguageDescription {
	if (typeof description !== "object" || description === null) throw new TypeError("Language description must be an object");
	assertLanguageId(description.id);
	return Object.freeze({
		id: description.id,
		aliases: normalizeTextList(description.aliases, "language aliases"),
		extensions: normalizeExtensions(description.extensions),
		filenames: normalizeTextList(description.filenames, "language filenames", true),
		filenamePatterns: normalizeTextList(description.filenamePatterns, "language filename patterns", true),
		mimetypes: normalizeTextList(description.mimetypes, "language MIME types", true),
		...(description.firstLine === undefined ? {} : { firstLine: normalizeFirstLinePattern(description.firstLine) }),
		...(description.configuration === undefined ? {} : { configuration: description.configuration }),
		...(description.icon === undefined ? {} : { icon: Object.freeze({ light: description.icon.light, dark: description.icon.dark }) }),
	});
}

function normalizePriority(options: LanguageRegistrationOptions): number {
	if (typeof options !== "object" || options === null) throw new TypeError("Language registration options must be an object");
	const priority = options.priority ?? 0;
	if (!Number.isSafeInteger(priority)) throw new RangeError("Language registration priority must be a safe integer");
	return priority;
}

function normalizeExtensions(values: readonly string[] | undefined): readonly string[] {
	const normalized = normalizeTextList(values, "language extensions", true).map(value => value.toLowerCase());
	if (normalized.some(value => !value.startsWith("."))) throw new TypeError("Language extensions must start with a dot");
	return Object.freeze(normalized);
}

function normalizeTextList(values: readonly string[] | undefined, owner: string, caseInsensitive = false): readonly string[] {
	if (values === undefined) return Object.freeze([]);
	if (!Array.isArray(values)) throw new TypeError(`${owner} must be an array`);
	const normalized = values.map(value => {
		if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\r\n]/u.test(value)) {
			throw new TypeError(`${owner} must contain bounded single-line strings`);
		}
		return caseInsensitive ? value.toLowerCase() : value;
	});
	if (new Set(normalized).size !== normalized.length) throw new RangeError(`${owner} must be unique`);
	return Object.freeze(normalized);
}

function normalizePath(path: string): string {
	return path.replace(/\\/gu, "/").toLowerCase();
}

function matchDescription(entry: RegisteredLanguageDescription, path: string, fileName: string, contentType: string | undefined, firstLine: string | undefined): LanguageMatch | undefined {
	const description = entry.description;
	if (contentType && description.mimetypes?.includes(contentType)) {
		return match(entry, 4, contentType.length);
	}
	if (description.filenames?.includes(fileName)) {
		return match(entry, 3, fileName.length);
	}
	const pattern = description.filenamePatterns?.find(value => matchesGlob(value, path) || matchesGlob(value, fileName));
	if (pattern) return match(entry, 2, pattern.length);
	const extension = description.extensions?.filter(value => path.endsWith(value)).sort((left, right) => right.length - left.length)[0];
	if (extension) return match(entry, 1, extension.length);
	if (firstLine !== undefined && entry.firstLinePattern?.test(firstLine)) return match(entry, 0, description.firstLine?.length ?? 0);
	return undefined;
}

function normalizeFirstLinePattern(value: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\r\n]/u.test(value)) throw new TypeError("Language first-line pattern must be a bounded single-line regular expression");
	const source = value.startsWith("^") ? value : `^(?:${value})`;
	let pattern: RegExp;
	try { pattern = new RegExp(source); }
	catch { throw new TypeError("Language first-line pattern must be a valid regular expression"); }
	if (pattern.test("")) throw new TypeError("Language first-line pattern must not match an empty line");
	return source;
}

function normalizeFirstLineText(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const withoutByteOrderMark = value.charCodeAt(0) === CharCode.UTF8_BOM ? value.slice(1) : value;
	return withoutByteOrderMark.slice(0, 1000);
}

function match(entry: RegisteredLanguageDescription, rank: number, specificity: number): LanguageMatch {
	return { languageId: entry.description.id, priority: entry.priority, rank, specificity, order: entry.order };
}

function compareMatches(left: LanguageMatch, right: LanguageMatch): number {
	return left.priority - right.priority || left.rank - right.rank || left.specificity - right.specificity || left.order - right.order;
}

function selectDescription(entries: readonly RegisteredLanguageDescription[] | undefined): RegisteredLanguageDescription | undefined {
	return entries?.reduce((best, entry) => !best || entry.priority > best.priority || (entry.priority === best.priority && entry.order > best.order) ? entry : best, undefined as RegisteredLanguageDescription | undefined);
}

function matchesGlob(pattern: string, value: string): boolean {
	let expression = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index]!;
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				expression += ".*";
			} else {
				expression += "[^/]*";
			}
		} else if (character === "?") {
			expression += "[^/]";
		} else {
			expression += escapeRegExpCharacters(character);
		}
	}
	try {
		return new RegExp(`${expression}$`, "u").test(value);
	} catch {
		return false;
	}
}
