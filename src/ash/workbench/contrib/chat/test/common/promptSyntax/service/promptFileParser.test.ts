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
