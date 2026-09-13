import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ParseErrorCode, SyntaxKind, createScanner, findNodeAtLocation, findNodeAtOffset, getLocation, getNodePath, getNodeValue, parse, parseTree } from '../../common/json.js';
import { getParseErrorMessage } from '../../common/jsonErrorMessages.js';

test('JSON compatibility scanner exposes VS Code style tokens and decoded values', () => {
	const scanner = createScanner('{"enabled": true, /* note */ "count": -1.5e2}');
	const kinds: SyntaxKind[] = [];
	const values: string[] = [];
	while (scanner.scan() !== SyntaxKind.EOF) {
		if (scanner.getToken() !== SyntaxKind.Trivia && scanner.getToken() !== SyntaxKind.LineBreakTrivia) {
			kinds.push(scanner.getToken());
			values.push(scanner.getTokenValue());
		}
	}

	assert.deepEqual(kinds, [
		SyntaxKind.OpenBraceToken,
		SyntaxKind.StringLiteral,
		SyntaxKind.ColonToken,
		SyntaxKind.TrueKeyword,
		SyntaxKind.CommaToken,
		SyntaxKind.BlockCommentTrivia,
		SyntaxKind.StringLiteral,
		SyntaxKind.ColonToken,
		SyntaxKind.NumericLiteral,
		SyntaxKind.CloseBraceToken,
	]);
	assert.equal(values[1], 'enabled');
	assert.equal(values[8], '-1.5e2');
});

test('JSON compatibility parser supports visitors, tree paths, and tolerant errors', () => {
	const errors: { error: ParseErrorCode; offset: number; length: number }[] = [];
	const value = parse('{"editor":{"enabled":true,},}', errors);
	assert.deepEqual(value, { editor: { enabled: true } });
	assert.deepEqual(errors, []);

	const treeErrors: { error: ParseErrorCode; offset: number; length: number }[] = [];
	const tree = parseTree('{"editor":{"enabled":true}}', treeErrors);
	assert.equal(treeErrors.length, 0);
	const enabled = findNodeAtLocation(tree, ['editor', 'enabled']);
	assert.equal(enabled?.type, 'boolean');
	assert.deepEqual(getNodePath(enabled), ['editor', 'enabled']);
	assert.equal(JSON.stringify(getNodeValue(tree)), '{"editor":{"enabled":true}}');
});

test('JSON compatibility location and diagnostics retain source offsets', () => {
	const source = '{"enabled": true,}';
	const errors: { error: ParseErrorCode; offset: number; length: number }[] = [];
	parse(source, errors, { allowTrailingComma: false });
	assert.ok(errors.some(error => error.error === ParseErrorCode.PropertyNameExpected));

	const tree = parseTree(source, [], { allowTrailingComma: true });
	const node = findNodeAtOffset(tree, source.indexOf('true'));
	assert.equal(node?.type, 'boolean');
	const location = getLocation(source, source.indexOf('true'));
	assert.deepEqual(location.path, ['enabled']);
	assert.equal(location.matches(['**', 'enabled']), true);
	assert.equal(getParseErrorMessage(ParseErrorCode.CloseBraceExpected), 'Closing brace expected');
});
