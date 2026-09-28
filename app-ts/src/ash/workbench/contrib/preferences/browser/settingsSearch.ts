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
	private readonly idFilter: string | undefined;
	private readonly terms: readonly string[];

	constructor(value: string) {
		const textTokens: string[] = [];
		let idFilter: string | undefined;
		for (const token of value.trim().split(/\s+/u).filter(Boolean)) {
			const normalized = token.toLocaleLowerCase();
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
		this.key = `${this.text}\0${idFilter ?? ''}`;
	}

	public get isEmpty(): boolean {
		return this.terms.length === 0 && !this.idFilter;
	}

	public matches(target: SettingsSearchTarget): boolean {
		if (this.idFilter && !target.id?.toLocaleLowerCase().includes(this.idFilter)) return false;
		if (this.terms.length === 0) return true;
		const searchableText = [target.title, target.description, ...(target.keywords ?? []), ...(target.tags ?? [])]
			.join(' ')
			.toLocaleLowerCase();
		return this.terms.every(term => searchableText.includes(term));
	}
}
