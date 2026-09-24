export interface PreferencesSearchTarget {
	readonly id?: string;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
	readonly tags?: readonly string[];
}

export interface PreferencesSearchQueryOptions {
	readonly isModified?: (id: string) => boolean;
}

/** Normalizes one Preferences query and matches it against searchable setting metadata. */
export class PreferencesSearchQuery {
	public readonly text: string;
	public readonly key: string;
	public readonly hasModifiedFilter: boolean;
	private readonly idFilter: string | undefined;
	private readonly terms: readonly string[];

	constructor(value: string, private readonly options: PreferencesSearchQueryOptions = {}) {
		const textTokens: string[] = [];
		let idFilter: string | undefined;
		let modified = false;
		for (const token of value.trim().split(/\s+/u).filter(Boolean)) {
			const normalized = token.toLocaleLowerCase();
			if (normalized === '@modified') {
				modified = true;
				continue;
			}
			if (normalized.startsWith('@id:')) {
				idFilter = normalized.slice('@id:'.length) || undefined;
				continue;
			}
			textTokens.push(token);
		}
		this.text = textTokens.join(' ')
			.replace(/[":]/gu, ' ')
			.replace(/\s+/gu, ' ')
			.trim()
			.toLocaleLowerCase();
		this.terms = this.text ? this.text.split(' ') : [];
		this.idFilter = idFilter;
		this.hasModifiedFilter = modified;
		this.key = `${this.text}\0${idFilter ?? ''}\0${modified}`;
	}

	public get isEmpty(): boolean {
		return this.terms.length === 0 && !this.idFilter && !this.hasModifiedFilter;
	}

	public matches(target: PreferencesSearchTarget): boolean {
		if (this.hasModifiedFilter && (!target.id || !this.options.isModified?.(target.id))) return false;
		if (this.idFilter && !target.id?.toLocaleLowerCase().includes(this.idFilter)) return false;
		if (this.terms.length === 0) return true;
		const searchableText = [target.title, target.description, ...(target.keywords ?? []), ...(target.tags ?? [])]
			.join(' ')
			.toLocaleLowerCase();
		return this.terms.every(term => searchableText.includes(term));
	}
}
