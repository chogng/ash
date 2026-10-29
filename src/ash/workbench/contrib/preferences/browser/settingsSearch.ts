export interface SettingsSearchTarget {
	readonly id?: string;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
	readonly tags?: readonly string[];
}

/** Normalizes one Settings query and matches it against searchable setting metadata. */
export class SettingsSearchQuery {
	public readonly text: string;
	public readonly key: string;
	public readonly hasModifiedFilter: boolean;
	public readonly languageFilter: string | undefined;
	private readonly idFilter: string | undefined;
	private readonly terms: readonly string[];
	private readonly tagFilters: readonly string[];
	private readonly stableOnly: boolean;

	constructor(value: string) {
		const textTokens: string[] = [];
		let idFilter: string | undefined;
		let hasModifiedFilter = false;
		const tagFilters = new Set<string>();
		let stableOnly = false;
		let languageFilter: string | undefined;
		for (const token of value.trim().split(/\s+/u).filter(Boolean)) {
			const normalized = token.toLocaleLowerCase();
			if (normalized.startsWith('@lang:')) {
				languageFilter ??= token.slice(6).replaceAll('"', '').split(',')[0] || undefined;
				continue;
			}
			if (normalized.startsWith('@tag:') && normalized.length > 5) {
				tagFilters.add(normalized.slice(5));
				continue;
			}
			if (normalized === '@stable') {
				stableOnly = true;
				continue;
			}
			if (normalized === '@modified') {
				hasModifiedFilter = true;
				continue;
			}
			if (normalized.startsWith('@id:')) {
				idFilter = normalized.slice('@id:'.length) || undefined;
				continue;
			}
			textTokens.push(token);
		}
		this.text = textTokens.join(' ').replace(/[":]/gu, ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
		this.terms = this.text ? this.text.split(' ') : [];
		this.idFilter = idFilter;
		this.hasModifiedFilter = hasModifiedFilter;
		this.tagFilters = [...tagFilters].sort();
		this.stableOnly = stableOnly;
		this.languageFilter = languageFilter;
		this.key = JSON.stringify([this.text, idFilter, hasModifiedFilter, this.tagFilters, stableOnly, languageFilter]);
	}

	public get isEmpty(): boolean {
		return this.terms.length === 0 && !this.idFilter && !this.hasModifiedFilter && !this.tagFilters.length && !this.stableOnly && !this.languageFilter;
	}

	public matches(target: SettingsSearchTarget): boolean {
		const tags = new Set(target.tags?.map(tag => tag.toLocaleLowerCase()));
		if (this.stableOnly && (tags.has('experimental') || tags.has('preview'))) return false;
		if (this.tagFilters.some(tag => !tags.has(tag))) return false;
		if (this.idFilter) {
			const id = target.id?.toLocaleLowerCase();
			const matchesId = this.idFilter.endsWith('*') ? id?.startsWith(this.idFilter.slice(0, -1)) : id === this.idFilter;
			if (!matchesId) return false;
		}
		if (this.terms.length === 0) return true;
		const searchableText = [target.id, target.title, target.description, ...(target.keywords ?? []), ...(target.tags ?? [])].join(' ').toLocaleLowerCase();
		return this.terms.every(term => searchableText.includes(term));
	}
}
