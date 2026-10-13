import { isCancellationError } from '../../../../../base/common/errors.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { createChatFileAttachments } from '../../browser/widget/input/editor/chatPasteProviders.js';

const dom = new JSDOM('<!doctype html><body></body>');
const globals = installEditorTestDom(dom, [], { FileReader: dom.window.FileReader });
suiteTeardown(() => { globals.dispose(); dom.window.close(); });

function file(content: string | Uint8Array, name = 'notes.txt', type = 'text/plain'): File {
	return new dom.window.File([typeof content === 'string' ? content : new Uint8Array(content)], name, { type });
}

test('File context preserves valid UTF-8 including the literal replacement character', async () => {
	const attachments = await createChatFileAttachments([file('line one\n literal \uFFFD')], new AbortController().signal, () => true);
	assert.equal(attachments.length, 1);
	assert.equal(attachments[0]!.kind, 'file');
	assert.deepEqual(await attachments[0]!.resolve(), { name: 'notes.txt', content: 'line one\n literal \uFFFD' });
});

for (const [name, bytes, message] of [
	['invalid-encoding.bin', new Uint8Array([0xff]), /must be a UTF-8 text file/u],
	['nul.bin', new Uint8Array([65, 0, 66]), /must contain nonempty UTF-8 text/u],
	['empty.txt', new Uint8Array(), /is empty/u],
	['whitespace.txt', new TextEncoder().encode(' \n\t'), /must contain nonempty UTF-8 text/u],
] as const) {
	test(`File context rejects ${name} before any batch is returned`, async () => {
		await assert.rejects(createChatFileAttachments([file('valid'), file(bytes, name)], new AbortController().signal, () => true), message);
	});
}

test('A text-only model rejects images but can prepare a following text batch', async () => {
	await assert.rejects(createChatFileAttachments([file(new Uint8Array([1]), 'image.png', 'image/png')], new AbortController().signal, () => false), /does not support images/u);
	const attachments = await createChatFileAttachments([file('following text')], new AbortController().signal, () => false);
	assert.deepEqual(await attachments[0]!.resolve(), { name: 'notes.txt', content: 'following text' });
});

test('Cancelling file reads rejects preparation before returning draft context', async () => {
	const controller = new AbortController();
	const preparing = createChatFileAttachments([file('unfinished')], controller.signal, () => true);
	const rejected = assert.rejects(preparing, isCancellationError);
	controller.abort();
	await rejected;
});
