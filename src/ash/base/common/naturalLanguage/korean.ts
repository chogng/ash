/** Returns the QWERTY keys that produce a modern Hangul character on a Korean keyboard. */
export function getKoreanAltChars(code: number): ArrayLike<number> | undefined {
	let keys: string | undefined;

	if (code >= 0x1100 && code <= 0x1112) {
		keys = initialKeys[code - 0x1100];
	} else if (code >= 0x1161 && code <= 0x1175) {
		keys = vowelKeys[code - 0x1161];
	} else if (code >= 0x11A8 && code <= 0x11C2) {
		keys = finalKeys[code - 0x11A8];
	} else if (code >= 0x3131 && code <= 0x3163) {
		keys = compatibilityKeys[code - 0x3131];
	} else if (code >= 0xAC00 && code <= 0xD7A3) {
		// Each syllable combines one of 19 initials, 21 vowels, and 28 finals.
		const syllable = code - 0xAC00;
		const initial = Math.floor(syllable / 588);
		const vowel = Math.floor(syllable % 588 / 28);
		const final = syllable % 28;
		keys = initialKeys[initial] + vowelKeys[vowel] + (final === 0 ? '' : finalKeys[final - 1]);
	}

	return keys === undefined ? undefined : Uint32Array.from(keys, key => key.charCodeAt(0));
}

const initialKeys = [
	'r', 'R', 's', 'e', 'E', 'f', 'a', 'q', 'Q', 't',
	'T', 'd', 'w', 'W', 'c', 'z', 'x', 'v', 'g',
];

const vowelKeys = [
	'k', 'o', 'i', 'O', 'j', 'p', 'u', 'P', 'h', 'hk', 'ho',
	'hl', 'y', 'n', 'nj', 'np', 'nl', 'b', 'm', 'ml', 'l',
];

const finalKeys = [
	'r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'f', 'fr', 'fa', 'fq',
	'ft', 'fx', 'fv', 'fg', 'a', 'q', 'qt', 't', 'T', 'd',
	'w', 'c', 'z', 'x', 'v', 'g',
];

// U+3131..U+3163 mixes consonants and vowels; U+3164 onward is a filler or archaic.
const compatibilityKeys = [
	'r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'E', 'f', 'fr', 'fa',
	'fq', 'ft', 'fx', 'fv', 'fg', 'a', 'q', 'Q', 'qt', 't',
	'T', 'd', 'w', 'W', 'c', 'z', 'x', 'v', 'g', 'k', 'o',
	'i', 'O', 'j', 'p', 'u', 'P', 'h', 'hk', 'ho', 'hl',
	'y', 'n', 'nj', 'np', 'nl', 'b', 'm', 'ml', 'l',
];
