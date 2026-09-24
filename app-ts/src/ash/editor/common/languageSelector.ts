import { assertLanguageId } from './languages/language.js';
import { type IRelativePattern, match as matchGlobPattern } from '../../base/common/glob.js';
import { URI } from '../../base/common/uri.js';

export interface LanguageFilter {
	readonly language?: string;
	readonly scheme?: string;
	readonly pattern?: string | IRelativePattern;
	readonly notebookType?: string;
	readonly hasAccessToAllModels?: boolean;
	readonly exclusive?: boolean;
	readonly isBuiltin?: boolean;
}

export type LanguageSelector = string | LanguageFilter | ReadonlyArray<string | LanguageFilter>;

export function score(selector: LanguageSelector | undefined, candidateUri: URI, candidateLanguage: string, candidateIsSynchronized: boolean, candidateNotebookUri: URI | undefined, candidateNotebookType: string | undefined): number {
	if (Array.isArray(selector)) {
		let ret = 0;
		for (const item of selector) {
			const value = score(item, candidateUri, candidateLanguage, candidateIsSynchronized, candidateNotebookUri, candidateNotebookType);
			if (value === 10) return value;
			if (value > ret) ret = value;
		}
		return ret;
	}
	if (typeof selector === 'string') {
		if (!candidateIsSynchronized) return 0;
		return selector === candidateLanguage ? 10 : selector === '*' ? 5 : 0;
	}
	if (!selector) return 0;
	const filter = selector as LanguageFilter;
	if (!candidateIsSynchronized && !filter.hasAccessToAllModels) return 0;
	if (filter.notebookType && candidateNotebookUri) candidateUri = candidateNotebookUri;
	let result = 0;
	if (filter.scheme) {
		if (filter.scheme === candidateUri.scheme) result = 10;
		else if (filter.scheme === '*') result = 5;
		else return 0;
	}
	if (filter.language) {
		if (filter.language === candidateLanguage) result = 10;
		else if (filter.language === '*') result = Math.max(result, 5);
		else return 0;
	}
	if (filter.notebookType) {
		if (filter.notebookType === candidateNotebookType) result = 10;
		else if (filter.notebookType === '*' && candidateNotebookType !== undefined) result = Math.max(result, 5);
		else return 0;
	}
	if (filter.pattern) {
		const path = candidateUri.fsPath;
		if (!matchGlobPattern(filter.pattern, path)) return 0;
		result = 10;
	}
	return result;
}

export function targetsNotebooks(selector: LanguageSelector): boolean {
	if (typeof selector === 'string') return false;
	if (Array.isArray(selector)) return selector.some(targetsNotebooks);
	return Boolean((selector as LanguageFilter).notebookType);
}

export function selectLanguageIds(selector: LanguageSelector, into: Set<string>): void {
	if (typeof selector === 'string') {
		into.add(selector);
	} else if (Array.isArray(selector)) {
		for (const item of selector) selectLanguageIds(item, into);
	} else {
		const language = (selector as LanguageFilter).language;
		if (language) into.add(language);
	}
}

/** Validates a provider selector, including the explicit all-languages selector. */
export function assertLanguageSelector(value: unknown): asserts value is string {
	if (value === "*") return;
	assertLanguageId(value);
}
