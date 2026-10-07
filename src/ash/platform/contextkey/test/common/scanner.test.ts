import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Scanner, TokenType } from '../../common/scanner.js';

test('scanner separates when-clause operators and preserves their source offsets', () => {
	const scanner = new Scanner().reset("name === 'docs' && count >= 2 || !locked");
	assert.deepEqual(scanner.scan().map(token => [Scanner.getLexeme(token), token.offset]), [
		['name', 0], ['===', 5], ['docs', 10], ['&&', 16], ['count', 19],
		['>=', 25], ['2', 28], ['||', 30], ['!', 33], ['locked', 34], ['EOF', 40],
	]);
	assert.deepEqual(scanner.errors, []);
});

test('scanner preserves path backslashes, Unicode words and regex character classes', () => {
	const tokens = new Scanner().reset(String.raw`路径 == 'C:\docs' && 路径 =~ /[a-z/]+\/docs/i`).scan();
	assert.deepEqual(tokens.map(Scanner.getLexeme), ['路径', '==', String.raw`C:\docs`, '&&', '路径', '=~', String.raw`/[a-z/]+\/docs/i`, 'EOF']);
	assert.equal(tokens[2].type, TokenType.QuotedStr);
	assert.equal(tokens[6].type, TokenType.RegexStr);
});

test('scanner reports malformed tokens and can scan another resource without stale errors', () => {
	const scanner = new Scanner().reset('left & right | third = value');
	const tokens = scanner.scan();
	assert.deepEqual(scanner.errors.map(({ offset, lexeme }) => ({ offset, lexeme })), [
		{ offset: 5, lexeme: '&' }, { offset: 13, lexeme: '|' }, { offset: 21, lexeme: '=' },
	]);
	assert.equal(tokens.at(-1)?.type, TokenType.EOF);
	assert.deepEqual(scanner.reset('false').scan().map(Scanner.getLexeme), ['false', 'EOF']);
	assert.deepEqual(scanner.errors, []);
});
