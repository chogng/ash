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

test('Prompt file references use Markdown grammar, exact CRLF coordinates and exclude code, HTML and images', () => {
	const uri = URI.parse('private://skill/review/SKILL.md?source=pinned');
	const source = '---\r\nname: review\r\n---\r\n[Guide](references/guide.md) and #file:assets/text.txt.\r\n`[ignored](secret.md)`\r\n```md\r\n[ignored](code.md)\r\n```\r\n![image](image.png)\r\n<div>[ignored](html.md)</div>\r\n[Web](https://example.com)';
	const body = new PromptFileParser().parse(uri, source).body!;
	assert.deepEqual(body.fileReferences, [
		{ content: 'references/guide.md', range: new Range(4, 9, 4, 28), isMarkdownLink: true },
		{ content: 'assets/text.txt', range: new Range(4, 40, 4, 55), isMarkdownLink: false },
	]);
	assert.equal(body.resolveFilePath('references/guide.md')?.toString(), uri.with({ path: '/review/references/guide.md' }).toString());
	assert.equal(body.resolveFilePath('javascript:alert(1)'), undefined);
	assert.equal(body.resolveFilePath('command:run'), undefined);
	assert.equal(body.resolveFilePath('#heading'), undefined);
	assert.equal(body.resolveFilePath('~/guide.md'), undefined);
});


test('Pinned package references remain inside the original package, including nested references and fragments', () => {
	const uri = URI.parse('private://skill/review/references/guide.md?source=pinned');
	const body = new PromptFileParser().parse(uri, 'Read the guide').body!;
	assert.equal(body.resolveFilePath('../assets/text.txt#section')?.toString(), uri.with({ path: '/review/assets/text.txt', fragment: 'section' }).toString());
	for (const path of ['../../escape.md', '/review/assets/text.txt', 'file:///host/secrets', 'private://skill/other/SKILL.md', 'https://example.com', '~/secret', 'a\\b', 'a\0b', 'a\nb']) assert.equal(body.resolveFilePath(path), undefined, path);
	const local = new PromptFileParser().parse(URI.file('/work/review/SKILL.md'), 'Local').body!;
	assert.equal(local.resolveFilePath('../shared.md')?.fsPath, '/work/shared.md');
});

test('YAML key ranges preserve quoted colons and missing scalars independently from empty text', () => {
	const header = new PromptFileParser().parse(URI.file('/work/review/SKILL.md'), '---\n"custom:key": text\nlicense:\nmetadata: { owner: "" }\n---').header!;
	assert.deepEqual(header.attributes[0].keyRange, new Range(2, 1, 2, 13));
	const license = header.getAttribute('license')!.value;
	assert.equal(license.type === 'scalar' && license.missing, true);
	const metadata = header.getAttribute('metadata')!.value;
	assert.equal(metadata.type === 'map' && metadata.properties[0].value.type === 'scalar' && metadata.properties[0].value.missing, undefined);
});
