import { ParseErrorCode } from './json.js';

export function getParseErrorMessage(errorCode: ParseErrorCode): string {
	switch (errorCode) {
		case ParseErrorCode.InvalidSymbol: return 'Invalid symbol';
		case ParseErrorCode.InvalidNumberFormat: return 'Invalid number format';
		case ParseErrorCode.PropertyNameExpected: return 'Property name expected';
		case ParseErrorCode.ValueExpected: return 'Value expected';
		case ParseErrorCode.ColonExpected: return 'Colon expected';
		case ParseErrorCode.CommaExpected: return 'Comma expected';
		case ParseErrorCode.CloseBraceExpected: return 'Closing brace expected';
		case ParseErrorCode.CloseBracketExpected: return 'Closing bracket expected';
		case ParseErrorCode.EndOfFileExpected: return 'End of file expected';
		case ParseErrorCode.InvalidCommentToken: return 'Comments are not permitted';
		case ParseErrorCode.UnexpectedEndOfComment: return 'Unexpected end of comment';
		case ParseErrorCode.UnexpectedEndOfString: return 'Unexpected end of string';
		case ParseErrorCode.UnexpectedEndOfNumber: return 'Unexpected end of number';
		case ParseErrorCode.InvalidUnicode: return 'Invalid Unicode escape sequence';
		case ParseErrorCode.InvalidEscapeCharacter: return 'Invalid escape character';
		case ParseErrorCode.InvalidCharacter: return 'Invalid character';
	}
}
