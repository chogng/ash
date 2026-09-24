import assert from 'node:assert/strict';
import { test } from 'mocha';
import { editJsonObjectProperty, formatJson, JsonTokenKind, parseJsonDocument, scanJson } from '../../common/json.js';
import { parse, parseJsonc, stripComments } from '../../common/jsonc.js';

test('JSON scanner retains JSONC structure and source ranges', () => {
	const source = '{\n\t// note\n\t"enabled": true,\n}\n';
	const scanned = scanJson(source, { allowComments: true, allowTrailingComma: true });

	assert.equal(scanned.errors.length, 0);
	assert.deepEqual(scanned.tokens.filter(token => token.kind !== JsonTokenKind.Trivia).map(token => token.kind), [
		JsonTokenKind.OpenBrace,
		JsonTokenKind.LineComment,
		JsonTokenKind.String,
		JsonTokenKind.Colon,
		JsonTokenKind.True,
		JsonTokenKind.Comma,
		JsonTokenKind.CloseBrace,
	]);
	assert.equal(source.slice(scanned.tokens[2]!.offset, scanned.tokens[2]!.offset + scanned.tokens[2]!.length), '// note');
});

test('JSON parser distinguishes strict JSON from JSONC', () => {
	const source = '{ "enabled": true, // note\n }';
	assert.match(parseJsonDocument(source).errors.map(error => error.message).join('\n'), /Comments|Trailing commas/u);
	assert.deepEqual(parseJsonc(source, 'settings'), { enabled: true });
	const document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
	assert.deepEqual(document.value, { enabled: true });
	assert.equal(document.root?.type, 'object');
	assert.match(parseJsonDocument('{"label":"bad\u0001value"}').errors[0]?.message ?? '', /control character/u);
	assert.ok(parseJsonDocument('{"enabled":\u00a0true}').errors.length > 0);
});

test('JSON object edits preserve unrelated comments and trailing-comma style', () => {
	const source = '{\n\t// user note\n\t"enabled": true,\n}\n';
	const updated = editJsonObjectProperty(source, 'enabled', false);
	const inserted = editJsonObjectProperty(updated, 'font.size', 14);
	const removed = editJsonObjectProperty(inserted, 'enabled', undefined);

	assert.match(updated, /user note/u);
	assert.match(updated, /"enabled": false/u);
	assert.match(inserted, /"font\.size": 14,/u);
	assert.match(removed, /user note/u);
	assert.doesNotMatch(removed, /"enabled"/u);
	assert.deepEqual(parseJsonc(removed, 'settings'), { 'font.size': 14 });
});

test('JSONC formatting preserves comments and produces valid source', () => {
	const formatted = formatJson('{"enabled":true,// note\n"items":[1,2,],}', { tabSize: 2, insertSpaces: true });

	assert.match(formatted, /\/\/ note/u);
	assert.match(formatted, /\n  "items": \[/u);
	assert.deepEqual(parseJsonc(formatted, 'formatted JSONC'), { enabled: true, items: [1, 2] });
});

test('JSONC compatibility helpers strip comments and trailing commas without touching strings', () => {
	const source = '{\n  "text": "// keep,}", /* remove */\n  "enabled": true,\n}\n';
	const stripped = stripComments(source);
	assert.match(stripped, /"text": "\/\/ keep,\}"/u);
	assert.doesNotMatch(stripped, /remove/u);
	assert.doesNotMatch(stripped, /true,\s*\}/u);
	assert.deepEqual(parse<{ text: string; enabled: boolean }>(source), { text: '// keep,}', enabled: true });
});
