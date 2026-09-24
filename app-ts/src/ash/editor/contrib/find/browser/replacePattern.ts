/** One literal segment or numbered capture in a replacement expression. */
export class ReplacePiece {
	public static staticValue(value: string): ReplacePiece { return new ReplacePiece(value, -1, null); }
	public static matchIndex(index: number): ReplacePiece { return new ReplacePiece(null, index, null); }
	public static caseOps(index: number, operations: string[]): ReplacePiece { return new ReplacePiece(null, index, [...operations]); }

	private constructor(
		public readonly staticValue: string | null,
		public readonly matchIndex: number,
		public readonly caseOps: string[] | null,
	) {}
}

interface NamedPiece {
	readonly name: string;
	readonly caseOps: readonly string[];
}

type Piece = ReplacePiece | NamedPiece;

/** Parsed replacement text shared by replace-one and replace-all. */
export class ReplacePattern {
	public static fromStaticValue(value: string): ReplacePattern {
		return new ReplacePattern([ReplacePiece.staticValue(value)]);
	}

	public readonly hasReplacementPatterns: boolean;
	private readonly pieces: readonly Piece[];

	constructor(pieces: Piece[] | null) {
		this.pieces = pieces?.length ? pieces : [ReplacePiece.staticValue('')];
		this.hasReplacementPatterns = this.pieces.some(piece => isNamedPiece(piece) || piece.staticValue === null);
	}

	public buildReplaceString(matches: string[] | null, preserveCase = false): string {
		const groups = (matches as (string[] & { groups?: Record<string, string | undefined> }) | null)?.groups;
		let result = '';
		for (const piece of this.pieces) {
			if (isNamedPiece(piece)) {
				result += applyCaseOperations(groups && Object.hasOwn(groups, piece.name) ? groups[piece.name] ?? '' : `$<${piece.name}>`, piece.caseOps);
		} else if (piece.staticValue !== null) {
				result += piece.staticValue;
			} else {
				result += applyCaseOperations(capture(matches, piece.matchIndex), piece.caseOps ?? []);
			}
		}
		return preserveCase ? preserveLetterCase(matches?.[0] ?? '', result) : result;
	}
}

/** Parse VS Code replacement tokens, including named captures supplied by Ash search results. */
export function parseReplaceString(source: string): ReplacePattern {
	const pieces: Piece[] = [];
	let literal = '';
	let caseOps: string[] = [];
	const flush = (): void => {
		if (literal) pieces.push(ReplacePiece.staticValue(literal));
		literal = '';
	};
	for (let index = 0; index < source.length; index++) {
		const character = source[index]!;
		const next = source[index + 1];
		if (character === '\\' && next !== undefined) {
			if (next === 'n' || next === 't' || next === '\\') {
				literal += next === 'n' ? '\n' : next === 't' ? '\t' : '\\';
				index++;
				continue;
			}
			if (next === 'u' || next === 'U' || next === 'l' || next === 'L') {
				caseOps.push(next);
				index++;
				continue;
			}
		}
		if (character !== '$' || next === undefined) {
			literal += character;
			continue;
		}
		if (next === '$') {
			literal += '$';
			index++;
			continue;
		}
		if (next === '&' || next >= '0' && next <= '9') {
			flush();
			let matchIndex = next === '&' ? 0 : Number(next);
			if (matchIndex > 0 && source[index + 2] && source[index + 2]! >= '0' && source[index + 2]! <= '9') {
				matchIndex = matchIndex * 10 + Number(source[index + 2]);
				index++;
			}
			pieces.push(caseOps.length ? ReplacePiece.caseOps(matchIndex, caseOps) : ReplacePiece.matchIndex(matchIndex));
			caseOps = [];
			index++;
			continue;
		}
		if (next === '<') {
			const end = source.indexOf('>', index + 2);
			if (end > index + 2) {
				flush();
				pieces.push({ name: source.slice(index + 2, end), caseOps });
				caseOps = [];
				index = end;
				continue;
			}
		}
		literal += '$';
	}
	flush();
	return new ReplacePattern(pieces);
}

function isNamedPiece(piece: Piece): piece is NamedPiece {
	return 'name' in piece;
}

function capture(matches: string[] | null, index: number): string {
	if (matches === null) return '';
	if (index < matches.length) return matches[index] ?? '';
	if (index >= 10 && Math.floor(index / 10) < matches.length) {
		return (matches[Math.floor(index / 10)] ?? '') + index % 10;
	}
	return `$${index}`;
}

function applyCaseOperations(value: string, operations: readonly string[]): string {
	let result = '';
	let operationIndex = 0;
	for (const character of value) {
		const operation = operations[operationIndex];
		result += operation === 'u' || operation === 'U' ? character.toUpperCase()
			: operation === 'l' || operation === 'L' ? character.toLowerCase() : character;
		if (operation === 'u' || operation === 'l') operationIndex++;
	}
	return result;
}

function preserveLetterCase(source: string, replacement: string): string {
	if (!source) return replacement;
	if (source === source.toUpperCase()) return replacement.toUpperCase();
	if (source === source.toLowerCase()) return replacement.toLowerCase();
	if (source[0] === source[0]?.toUpperCase() && source.slice(1) === source.slice(1).toLowerCase()) {
		return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
	}
	return replacement;
}
