import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { serializeChatMarkdownTable } from '../../../../browser/widget/chatContentParts/chatMarkdownTableCsv.js';

suite('Chat Markdown table CSV', () => {
	for (const prefix of ['', ' ', '\t', '\r', '\n', '\r\n\t ', '\u0000\u001b', '\u007f\u0085', '\u00a0', '\ufeff', '\u200b\u202e']) {
		test(`protects formula text after ${JSON.stringify(prefix)}`, () => {
			for (const formula of ['=1+1', '+1+1', '-1+1', '@SUM(1)', '＝1+1', '＋1+1', '－1+1', '＠SUM(1)', '-42', '+42', '-1.5e2']) {
				assert.equal(serializeChatMarkdownTable([[prefix + formula]]), `"'${prefix}${formula}"\r\n`);
			}
		});
	}

	test('preserves ordinary text and CSV field boundaries', () => {
		assert.equal(serializeChatMarkdownTable([
			['Name', 'Value', ''],
			['中文', '42', '00123'],
			['1.5e2', 'a=b', "'=1+1"],
			[' leading and trailing ', '\tplain', '\ufeffplain'],
			['say "hi", please', 'line\nbreak', 'line\r\nbreak'],
			['=SUM(1,2)', '=1+1",=2+2', '=1+1\n=2+2'],
		]), '"Name","Value",""\r\n'
		+ '"中文","42","00123"\r\n'
		+ '"1.5e2","a=b","\'=1+1"\r\n'
		+ '" leading and trailing ","\tplain","\ufeffplain"\r\n'
		+ '"say ""hi"", please","line\nbreak","line\r\nbreak"\r\n'
		+ '"\'=SUM(1,2)","\'=1+1"",=2+2","\'=1+1\n=2+2"\r\n');
	});
});
