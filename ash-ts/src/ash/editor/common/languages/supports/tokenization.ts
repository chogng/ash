import { StandardTokenType } from '../../encodedTokenAttributes.js';

/** Classifies language scopes without treating a substring inside a word as a token type. */
export function toStandardTokenType(tokenType: string): StandardTokenType {
	for (const scope of tokenType.split(/\W+/u)) {
		switch (scope) {
			case 'comment': return StandardTokenType.Comment;
			case 'string': return StandardTokenType.String;
			case 'regex':
			case 'regexp': return StandardTokenType.RegEx;
		}
	}
	return StandardTokenType.Other;
}
