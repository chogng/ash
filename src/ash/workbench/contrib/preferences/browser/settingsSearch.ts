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
	private readonly idFilter: string | undefined;
	private readonly terms: readonly string[];

	constructor(value: string) {
		const textTokens: string[] = [];
		let idFilter: string | undefined;
		let hasModifiedFilter = false;
		for (const token of value.trim().split(/\s+/u).filter(Boolean)) {
			const normalized = token.toLocaleLowerCase();
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
		this.text = textTokens.join(' ')
			.replace(/[":]/gu, ' ')
			.replace(/\s+/gu, ' ')
			.trim()
			.toLocaleLowerCase();
		this.terms = this.text ? this.text.split(' ') : [];
		this.idFilter = idFilter;
		this.hasModifiedFilter = hasModifiedFilter;
		this.key = `${this.text}\0${idFilter ?? ''}\0${hasModifiedFilter}`;
	}

	public get isEmpty(): boolean {
		return this.terms.length === 0 && !this.idFilter && !this.hasModifiedFilter;
	}

	public matches(target: SettingsSearchTarget): boolean {
		if (this.idFilter) {
			const id = target.id?.toLocaleLowerCase();
			const matchesId = this.idFilter.endsWith('*')
				? id?.startsWith(this.idFilter.slice(0, -1))
				: id === this.idFilter;
			if (!matchesId) return false;
		}
		if (this.terms.length === 0) return true;
		const searchableText = [target.title, target.description, ...(target.keywords ?? []), ...(target.tags ?? [])]
			.join(' ')
			.toLocaleLowerCase();
		return this.terms.every(term => searchableText.includes(term));
	}
}
