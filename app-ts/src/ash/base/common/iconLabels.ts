/** A half-open range used to highlight a label or map a fuzzy match. */
export interface IMatch {
	start: number;
	end: number;
}

export interface IParsedLabelWithIcons {
	readonly text: string;
	readonly iconOffsets?: readonly number[];
}

const iconStartMarker = '$(';
const iconNamePattern = '[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*';
const iconPattern = `\\$\\(${iconNamePattern}(?:~[A-Za-z]+)?\\)`;
const iconsRegex = new RegExp(iconPattern, 'gu');
const escapeIconsRegex = new RegExp(`(\\\\)?${iconPattern}`, 'gu');
const stripIconsRegex = new RegExp(`(\\s)?(\\\\)?${iconPattern}(\\s)?`, 'gu');

/** Escapes icon syntax so a label is displayed as literal text. */
export function escapeIcons(text: string): string {
	return text.replace(escapeIconsRegex, (match, escaped: string | undefined) => escaped ? match : `\\${match}`);
}

/** Escapes an already escaped icon once more for Markdown content. */
export function markdownEscapeEscapedIcons(text: string): string {
	return text.replace(new RegExp(`\\\\${iconPattern}`, 'gu'), match => `\\${match}`);
}

/** Removes rendered icon syntax while preserving escaped literal icons. */
export function stripIcons(text: string): string {
	if (!text.includes(iconStartMarker)) return text;
	return text.replace(stripIconsRegex, (match, preWhitespace: string | undefined, escaped: string | undefined, postWhitespace: string | undefined) => {
		if (escaped) return match;
		return preWhitespace || postWhitespace || '';
	});
}

/** Converts icon syntax to words that screen readers can pronounce. */
export function getIconAriaLabel(text: string | undefined): string {
	if (!text) return '';
	return text.replace(/\$\((.*?)\)/gu, (_match, iconName: string) => ` ${iconName} `).trim();
}

/** VS Code-compatible name for callers migrating from codicon terminology. */
export const getCodiconAriaLabel = getIconAriaLabel;

/**
 * Removes icon syntax and records the source offset at every visible text
 * character. The offsets allow fuzzy matches to be mapped back to the source.
 */
export function parseLabelWithIcons(input: string): IParsedLabelWithIcons {
	iconsRegex.lastIndex = 0;
	let text = '';
	const iconOffsets: number[] = [];
	let iconsOffset = 0;
	let cursor = 0;

	for (const match of input.matchAll(iconsRegex)) {
		const index = match.index ?? cursor;
		const chars = input.slice(cursor, index);
		text += chars;
		for (let i = 0; i < chars.length; i += 1) iconOffsets.push(iconsOffset);
		iconsOffset += match[0].length;
		cursor = index + match[0].length;
	}

	const tail = input.slice(cursor);
	text += tail;
	for (let i = 0; i < tail.length; i += 1) iconOffsets.push(iconsOffset);

	return { text, iconOffsets };
}

/** A small subsequence matcher suitable for labels and tree filtering. */
export function matchesFuzzy(
	query: string,
	target: string,
	_enableSeparateSubstringMatching = false,
): IMatch[] | null {
	if (query.length === 0) return [];
	const matches: IMatch[] = [];
	let targetIndex = 0;
	for (const queryCharacter of query) {
		const lowerQueryCharacter = queryCharacter.toLocaleLowerCase();
		let found = -1;
		while (targetIndex < target.length) {
			const candidateIndex = targetIndex;
			targetIndex += 1;
			if (target[candidateIndex]?.toLocaleLowerCase() === lowerQueryCharacter) {
				found = candidateIndex;
				break;
			}
		}
		if (found < 0) return null;
		const previous = matches.at(-1);
		if (previous && previous.end === found) previous.end = found + 1;
		else matches.push({ start: found, end: found + 1 });
	}
	return matches;
}

/** Fuzzy matches a label while ignoring source positions occupied by icons. */
export function matchesFuzzyIconAware(
	query: string,
	target: IParsedLabelWithIcons,
	enableSeparateSubstringMatching = false,
): IMatch[] | null {
	const { text, iconOffsets } = target;
	if (!iconOffsets || iconOffsets.length === 0) return matchesFuzzy(query, text, enableSeparateSubstringMatching);

	const leadingWhitespace = text.length - text.trimStart().length;
	const matches = matchesFuzzy(query, text.trimStart(), enableSeparateSubstringMatching);
	if (!matches) return null;
	for (const match of matches) {
		const visibleIndex = match.start + leadingWhitespace;
		const iconOffset = iconOffsets[visibleIndex] ?? 0;
		match.start += iconOffset + leadingWhitespace;
		match.end += iconOffset + leadingWhitespace;
	}
	return matches;
}
