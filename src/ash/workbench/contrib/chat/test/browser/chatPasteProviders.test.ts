import { isCancellationError } from '../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { ChatAttachmentResolveService } from '../../browser/attachments/chatAttachmentResolveService.js';
import { createChatFileAttachments } from '../../browser/widget/input/editor/chatPasteProviders.js';
import { URI } from '../../../../../base/common/uri.js';

// File preparation uses only the resolver's in-memory image port in this suite.
const resolver = new ChatAttachmentResolveService(
	{} as IFileService,
	{} as IWorkingCopyService,
	{} as IFileSearchService,
	{} as IWorkspaceContextService,
);

test('native text drops retain their real source URI alongside the captured bytes', async () => {
	const dropped = file('Captured original bytes', 'source.ts');
	const source = URI.file('/workspace/source.ts');
	Object.defineProperty(dropped, 'path', { value: source.fsPath });
	const [attachment] = await createChatFileAttachments([dropped], new AbortController().signal, () => true, resolver);
	assert.equal(attachment!.resource?.toString(), source.toString());
	assert.equal((await attachment!.resolve()).content, 'Captured original bytes');
});

const dom = new JSDOM('<!doctype html><body></body>');
const globals = installEditorTestDom(dom, [], { FileReader: dom.window.FileReader });
suiteTeardown(() => { globals.dispose(); dom.window.close(); });

function file(content: string | Uint8Array, name = 'notes.txt', type = 'text/plain'): File {
	return new dom.window.File([typeof content === 'string' ? content : new Uint8Array(content)], name, { type });
}

test('File context preserves valid UTF-8 including the literal replacement character', async () => {
	const attachments = await createChatFileAttachments([file('line one\n literal \uFFFD')], new AbortController().signal, () => true, resolver);
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
		await assert.rejects(createChatFileAttachments([file('valid'), file(bytes, name)], new AbortController().signal, () => true, resolver), message);
	});
}

test('A text-only model rejects images but can prepare a following text batch', async () => {
	await assert.rejects(createChatFileAttachments([file(new Uint8Array([1]), 'image.png', 'image/png')], new AbortController().signal, () => false, resolver), /does not support images/u);
	const attachments = await createChatFileAttachments([file('following text')], new AbortController().signal, () => false, resolver);
	assert.deepEqual(await attachments[0]!.resolve(), { name: 'notes.txt', content: 'following text' });
});

test('Cancelling file reads rejects preparation before returning draft context', async () => {
	const controller = new AbortController();
	const preparing = createChatFileAttachments([file('unfinished')], controller.signal, () => true, resolver);
	const rejected = assert.rejects(preparing, isCancellationError);
	controller.abort();
	await rejected;
});

for (const type of ['', 'application/octet-stream', 'image/png']) {
	test(`Image files with MIME '${type}' are rejected before reads when the model lacks image support`, async () => {
		await assert.rejects(createChatFileAttachments([file(new Uint8Array([1]), 'capture.PNG', type)], new AbortController().signal, () => false, resolver), /does not support images/u);
	});

	test(`Image files with MIME '${type}' enforce the size bound before reading or decoding`, async () => {
		const image = file(new Uint8Array([1]), 'capture.PNG', type);
		Object.defineProperty(image, 'size', { value: 20 * 1024 * 1024 + 1 });
		await assert.rejects(createChatFileAttachments([image], new AbortController().signal, () => true, resolver), /20 MB image limit/u);
	});
}

for (const change of ['model', 'cancellation'] as const) {
	test(`Image preparation rejects the entire mixed batch after a ${change} change during decoding`, async () => {
		const started = new DeferredPromise<void>();
		const decoded = new DeferredPromise<Awaited<ReturnType<typeof resolver.resolveImageAttachContext>>>();
		const controller = new AbortController();
		let supportsImages = true;
		const preparing = createChatFileAttachments([file('Captured text'), file(new Uint8Array([1]), 'capture.PNG', '')], controller.signal, () => supportsImages, {
			resolveImageAttachContext: async (images, signal) => {
				assert.equal(images[0]!.mimeType, 'image/png');
				assert.ok(signal);
				await started.complete();
				return decoded.p;
			},
		});
		await started.p;
		if (change === 'model') supportsImages = false;
		else controller.abort();
		await decoded.complete([{ id: 'image', kind: 'image', name: 'capture.PNG', resolve: async () => ({ name: 'capture.PNG', kind: 'image', content: 'data:image/png;base64,captured' }) }]);
		await assert.rejects(preparing, change === 'model' ? /does not support images/u : isCancellationError);
	});
}

test('A model change while the last text file is reading rejects an already decoded image', async () => {
	let releaseText!: () => void;
	using readerGlobals = installEditorTestDom(dom, [], {
		FileReader: class extends dom.window.FileReader {
			override readAsArrayBuffer(blob: Blob): void {
				if ((blob as File).name === 'slow.txt') releaseText = () => super.readAsArrayBuffer(blob);
				else super.readAsArrayBuffer(blob);
			}
		},
	});
	let supportsImages = true;
	let imageDecoded = false;
	const imageChecked = new DeferredPromise<void>();
	const preparing = createChatFileAttachments([file('Captured text', 'slow.txt'), file(new Uint8Array([1]), 'capture.PNG', '')], new AbortController().signal, () => {
		if (imageDecoded) void imageChecked.complete();
		return supportsImages;
	}, {
		resolveImageAttachContext: async () => {
			imageDecoded = true;
			return [{ id: 'image', kind: 'image', name: 'capture.PNG', resolve: async () => ({ name: 'capture.PNG', kind: 'image', content: 'data:image/png;base64,captured' }) }];
		},
	});
	await imageChecked.p;
	supportsImages = false;
	releaseText();
	await assert.rejects(preparing, /does not support images/u);
});
