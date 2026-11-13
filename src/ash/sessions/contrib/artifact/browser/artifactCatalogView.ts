import { formatTimeAgo } from '../../../../base/common/date.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { ArtifactKind } from '../../../common/artifactKind.js';
import type { ArtifactCard } from './artifactWorkspaceRegistry.js';

export type ArtifactSort = 'modified' | 'created' | 'name';
export type ArtifactOwner = 'anyone' | 'you' | 'others';

export interface ArtifactCatalogOptions {
	readonly sort: ArtifactSort;
	readonly descending: boolean;
	readonly owner: ArtifactOwner;
	readonly kind: ArtifactKind | 'any';
}

export function selectArtifactCards(cards: readonly ArtifactCard[], options: ArtifactCatalogOptions, query: string): ArtifactCard[] {
	const normalized = query.trim().toLocaleLowerCase();
	return cards.filter(card => (!normalized || card.title.toLocaleLowerCase().includes(normalized))
		&& (options.owner === 'anyone' || card.owner === options.owner)
		&& (options.kind === 'any' || card.kind === options.kind)).sort((a, b) => {
			const byName = a.title.localeCompare(b.title);
			if (options.sort === 'name') return byName * (options.descending ? -1 : 1);
			const left = options.sort === 'created' ? a.createdAt : a.modifiedAt ?? a.createdAt;
			const right = options.sort === 'created' ? b.createdAt : b.modifiedAt ?? b.createdAt;
			// Unknown dates stay last in both directions. Never substitute the time a file was opened.
			if (left === undefined || right === undefined) return left === right ? byName : left === undefined ? 1 : -1;
			return (left - right) * (options.descending ? -1 : 1) || byName;
		});
}

// Reuse Intl instances across cards and minute ticks; replace them when the UI language changes.
let dateFormatters: { locale: string; full: Intl.DateTimeFormat; short: Intl.DateTimeFormat; year: Intl.DateTimeFormat; relative: Intl.RelativeTimeFormat; } | undefined;

export function artifactDate(timestamp: number | undefined, now = Date.now()): { readonly label: string; readonly title: string; } {
	if (timestamp === undefined) {
		const label = localize('sessions.artifacts.dateUnavailable', 'Date unavailable');
		return { label, title: label };
	}
	const locale = getNLSLanguage();
	if (dateFormatters?.locale !== locale) {
		dateFormatters = {
			locale, full: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }),
			short: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
			year: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
			relative: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
		};
	}
	const date = new Date(timestamp);
	const title = dateFormatters.full.format(date);
	const elapsed = now - timestamp;
	const label = elapsed >= 0 && elapsed < 60_000 ? localize('sessions.artifacts.justNow', 'Just now')
		: elapsed >= 0 && elapsed < 7 * 86_400_000 ? formatTimeAgo(timestamp, now, dateFormatters.relative)!
			: (date.getFullYear() === new Date(now).getFullYear() ? dateFormatters.short : dateFormatters.year).format(date);
	return { label, title };
}
