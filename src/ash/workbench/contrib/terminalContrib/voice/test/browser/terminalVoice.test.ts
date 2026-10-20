import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { postProcessTerminalDictation } from '../../browser/terminalVoice.js';

test('terminal dictation translates spoken English symbols once, longest phrase first, and normalizes sentence capitalization', () => {
	assert.equal(postProcessTerminalDictation('Ls dash la.'), 'ls - la');
	assert.equal(postProcessTerminalDictation('Echo dollar sign PATH pipe grep double quote home double quote'), 'echo $ PATH | grep " home "');
	assert.equal(postProcessTerminalDictation('a ampersand b ampersand c'), 'a & b & c');
	assert.equal(postProcessTerminalDictation('echo open angle bracket close bracket semicolon'), 'echo < ] ;');
	assert.equal(postProcessTerminalDictation('echo dollar  sign PATH'), 'echo $ PATH');
});

test('terminal dictation preserves non-English words and filters terminal controls and Enter', () => {
	assert.equal(postProcessTerminalDictation('打开中文文件 哈dash哈 dash'), '打开中文文件 哈dash哈 -');
	assert.equal(postProcessTerminalDictation('Écho bonjour'), 'Écho bonjour');
	assert.equal(postProcessTerminalDictation('echo\r\nhello\x00\x1b\x7f\x9b'), 'echo hello');
	assert.equal(postProcessTerminalDictation('dashed backslashes hashValue'), 'dashed backslashes hashValue');
});
