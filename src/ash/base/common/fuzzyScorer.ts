/** A positive score and ascending UTF-16 match positions; zero means no match. */
export type FuzzyScore = [number, number[]];

/**
 * Scores case-insensitive ordered matches, treating path separators alike.
 * Word starts and adjacent characters receive common bonuses; label preference
 * and length penalties remain with the caller. Up to 65,536 scoring cells, the
 * strongest alignment wins. Larger inputs retain the first valid alignment so
 * extension-provided labels cannot force quadratic work or storage per item.
 */
export function scoreFuzzy(
	target: string,
	query: string,
	queryLower: string,
	allowNonContiguousMatches: boolean,
): FuzzyScore {
	if (!target || !query) return [0, []];
	const targetLower = target.toLowerCase();
	const pattern = [...foldCharacters(query, queryLower)];
	const firstMatch = findFirstMatch(foldCharacters(target, targetLower), pattern, allowNonContiguousMatches);
	if (firstMatch.length === 0) return [0, []];
	if (targetLower.length * pattern.length > 65_536) {
		let score = 0;
		for (let index = 0; index < firstMatch.length; index++) {
			const character = firstMatch[index]!;
			score += characterScore(character, pattern[index]!);
			if (index > 0 && character.index === firstMatch[index - 1]!.index + 1) score += 6;
		}
		return [score, matchPositions(firstMatch)];
	}

	const candidate = [...foldCharacters(target, targetLower)];
	// Only admitted small inputs allocate predecessor rows (at most 256 KiB of
	// indices). Large inputs use the linear scan above, including contiguous mode.
	let previous = new Float64Array(candidate.length).fill(Number.NEGATIVE_INFINITY);
	const predecessors: Int32Array[] = [];
	for (let piece = 0; piece < pattern.length; piece++) {
		const scores = new Float64Array(candidate.length).fill(Number.NEGATIVE_INFINITY);
		const links = new Int32Array(candidate.length).fill(-1);
		let earlierScore = Number.NEGATIVE_INFINITY;
		let earlierIndex = -1;
		let matched = false;
		for (let position = 0; position < candidate.length; position++) {
			if (position > 1 && previous[position - 2]! > earlierScore) {
				earlierScore = previous[position - 2]!;
				earlierIndex = position - 2;
			}
			const character = candidate[position]!;
			const expected = pattern[piece]!;
			if (!equalCharacters(character, expected)) continue;
			let priorScore = piece === 0 ? 0 : Number.NEGATIVE_INFINITY;
			let priorIndex = -1;
			if (piece > 0) {
				if (allowNonContiguousMatches) {
					priorScore = earlierScore;
					priorIndex = earlierIndex;
				}
				if (position > 0 && previous[position - 1]! + 6 > priorScore) {
					priorScore = previous[position - 1]! + 6;
					priorIndex = position - 1;
				}
			}
			if (!Number.isFinite(priorScore)) continue;
			scores[position] = priorScore + characterScore(character, expected);
			links[position] = priorIndex;
			matched = true;
		}
		if (!matched) return [0, []];
		previous = scores;
		predecessors.push(links);
	}

	let end = 0;
	for (let position = 1; position < previous.length; position++) {
		if (previous[position]! > previous[end]!) end = position;
	}
	const score = previous[end]!;
	const matchedCharacters: FoldedCharacter[] = [];
	for (let piece = pattern.length - 1; piece >= 0; piece--) {
		matchedCharacters.push(candidate[end]!);
		end = predecessors[piece]![end]!;
	}
	return [score, matchPositions(matchedCharacters.reverse())];
}

function matchPositions(characters: readonly FoldedCharacter[]): number[] {
	const positions: number[] = [];
	for (const character of characters) {
		// A case expansion can match twice against one source character. Highlight
		// that character once, including both UTF-16 units of an astral character.
		for (let offset = character.offset; offset < character.offset + character.original.length; offset++) {
			if (offset > (positions.at(-1) ?? -1)) positions.push(offset);
		}
	}
	return positions;
}

interface FoldedCharacter {
	readonly value: string;
	readonly original: string;
	readonly offset: number;
	readonly index: number;
	readonly boundary: boolean;
}

function* foldCharacters(source: string, lowercase: string): IterableIterator<FoldedCharacter> {
	const folded = lowercase[Symbol.iterator]();
	let offset = 0;
	let index = 0;
	let previous = '';
	for (const original of source) {
		const boundary =
			offset === 0 ||
			/[\s._:/\\'"-]/.test(previous) ||
			(previous.toLowerCase() === previous &&
				previous.toUpperCase() !== previous &&
				original.toUpperCase() === original &&
				original.toLowerCase() !== original);
		let first = true;
		for (const _character of original.toLowerCase()) {
			yield { value: folded.next().value!, original, offset, index: index++, boundary: first && boundary };
			first = false;
		}
		offset += original.length;
		previous = original;
	}
}

function equalCharacters(left: FoldedCharacter, right: FoldedCharacter): boolean {
	return (
		left.value === right.value ||
		((left.value === '/' || left.value === '\\') && (right.value === '/' || right.value === '\\'))
	);
}

function characterScore(character: FoldedCharacter, expected: FoldedCharacter): number {
	return 2 + (character.boundary ? 6 : 0) + (character.original === expected.original ? 1 : 0);
}

function findFirstMatch(
	candidate: Iterable<FoldedCharacter>,
	pattern: readonly FoldedCharacter[],
	allowNonContiguousMatches: boolean,
): FoldedCharacter[] {
	if (allowNonContiguousMatches) {
		const result: FoldedCharacter[] = [];
		for (const character of candidate) {
			if (equalCharacters(character, pattern[result.length]!)) result.push(character);
			if (result.length === pattern.length) return result;
		}
		return [];
	}

	// Prefix links reuse partial contiguous matches without restarting the scan.
	const prefixes = new Int32Array(pattern.length);
	for (let index = 1, length = 0; index < pattern.length; index++) {
		while (length > 0 && !equalCharacters(pattern[index]!, pattern[length]!)) length = prefixes[length - 1]!;
		if (equalCharacters(pattern[index]!, pattern[length]!)) length++;
		prefixes[index] = length;
	}
	const window = new Array<FoldedCharacter>(pattern.length);
	let length = 0;
	for (const character of candidate) {
		window[character.index % pattern.length] = character;
		while (length > 0 && !equalCharacters(character, pattern[length]!)) length = prefixes[length - 1]!;
		if (equalCharacters(character, pattern[length]!)) length++;
		if (length === pattern.length) {
			return Array.from({ length }, (_, index) => window[(character.index - length + 1 + index) % length]!);
		}
	}
	return [];
}
