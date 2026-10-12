import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../../../base/common/uri.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { PromptFileParser } from '../../../../common/promptSyntax/promptFileParser.js';

for (const eol of ['\n', '\r\n', '\r']) {
	test(`Prompt body retains exact source endings ${JSON.stringify(eol)} and editor coordinates`, () => {
		const uri = URI.file('/skills/review/SKILL.md');
		const header = ['---', 'name: review', 'description: Review changes', '---'].join(eol) + eol;
		const body = ['# Review 🧩', 'Keep the exact file.', ''].join(eol);
		const parsed = new PromptFileParser().parse(uri, header + body);
		assert.equal(parsed.content, header + body);
		assert.equal(parsed.body?.getContent(), body);
		assert.equal(parsed.body?.offset, header.length);
		assert.deepEqual(parsed.body?.range, new Range(5, 1, 7, 1));
		assert.equal(parsed.body?.uri, uri);
	});
}

test('Prompt files without a complete header preserve their entire body', () => {
	const parser = new PromptFileParser();
	const uri = URI.file('/SKILL.md');
	for (const content of ['Plain body', '---\nname: review\nUnterminated header']) {
		const parsed = parser.parse(uri, content);
		assert.equal(parsed.body?.getContent(), content);
		assert.equal(parsed.body?.offset, 0);
		assert.equal(parsed.body?.range.startLineNumber, 1);
	}
	for (const content of ['', '---\nname: review\n---', '---\r\nname: review\r\n---\r\n']) {
		assert.equal(parser.parse(uri, content).body, undefined);
	}
});

test('Prompt YAML AST preserves quoted keys, folded and literal values, maps and sequences with CRLF coordinates', () => {
	const source = '---\r\n"name": review\r\ndescription: >-\r\n  Review\r\n  changes.\r\nmetadata:\r\n  owner: "team: editor"\r\n  related: [one, two]\r\nlicense: |\r\n  Use freely.\r\n---\r\nBody';
	const header = new PromptFileParser().parse(URI.file('/skills/review/SKILL.md'), source).header!;
	assert.deepEqual(header.errors, []);
	assert.deepEqual(header.getAttribute('name')?.range, new Range(2, 1, 2, 15));
	const description = header.getAttribute('description')!.value;
	assert.equal(description.type === 'scalar' && description.value, 'Review changes.');
	const metadata = header.getAttribute('metadata')!.value;
	assert.equal(metadata.type, 'map');
	if (metadata.type !== 'map') throw new Error('Expected metadata map');
	assert.equal(metadata.properties[0]!.value.type, 'scalar');
	assert.deepEqual(metadata.properties[0]!.key.range, new Range(7, 3, 7, 8));
	assert.equal(metadata.properties[1]!.value.type, 'sequence');
	const license = header.getAttribute('license')!.value;
	assert.equal(license.type === 'scalar' && license.format, 'literal');
});

test('Prompt AST reports malformed YAML, duplicate keys and unsupported aliases without expanding references', () => {
	const parser = new PromptFileParser();
	const uri = URI.file('/skills/review/SKILL.md');
	for (const [source, code] of [
		['name: one\nname: two', 'DUPLICATE_KEY'],
		['name: [one', 'BAD_INDENT'],
		['metadata: &a { self: *a }', 'unsupportedYaml'],
		['name: !!str review', 'unsupportedYaml'],
	] as const) {
		const parsed = parser.parse(uri, `---\n${source}\n---\nBody`);
		assert.ok(parsed.header!.errors.length, code);
		if (code !== 'BAD_INDENT') assert.ok(parsed.header!.errors.some(error => error.code === code), JSON.stringify(parsed.header!.errors));
		for (const error of parsed.header!.errors) assert.ok(error.range.startLineNumber >= 2);
	}
	assert.equal(parser.parse(uri, '---\nname: review').header!.errors[0]!.code, 'unclosedHeader');
	assert.equal(parser.parse(uri, `---\n${'x'.repeat(17000)}\n---`).header!.errors[0]!.code, 'headerTooLarge');
});
