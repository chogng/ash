import { CancellationError } from '../../../../../../../base/common/errors.js';
import { addDisposableListener } from '../../../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../../nls.js';
import type { ChatContextAttachment } from '../../../../../../services/chat/common/chatContextService.js';
import { createImageAttachment } from '../../../chatImageUtils.js';

/** Prepares one atomic file batch for any composer; the caller owns its draft and cancellation. */
export async function createChatFileAttachments(files: readonly File[], signal: AbortSignal, supportsImages: () => boolean): Promise<readonly ChatContextAttachment[]> {
	const batch = new AbortController();
	signal = AbortSignal.any([signal, batch.signal]);
	try {
		return await Promise.all(files.map(async file => {
			if (signal.aborted) throw new CancellationError();
			const image = /^image\/(png|jpeg|gif|webp)$/u.test(file.type);
			if (image && !supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
			// Bound image allocation before reading; image processing also bounds the encoded result.
			if (image && file.size > 20 * 1024 * 1024) throw new Error(localize('chat.image.tooLarge', '{0} exceeds the 20 MB image limit', file.name));
			const bytes = await readFile(file, signal);
			if (!bytes.length) throw new Error(localize('chat.attach.empty', '{0} is empty', file.name));
			if (image) {
				const attachment = await createImageAttachment(file.name, bytes, file.type);
				if (signal.aborted) throw new CancellationError();
				if (!supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
				return attachment;
			}
			let content: string;
			try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
			catch { throw new Error(localize('chat.attach.binary', '{0} must be a UTF-8 text file or a PNG, JPEG, GIF, or WebP image', file.name)); }
			if (content.includes('\0') || !content.trim()) throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', file.name));
			return { id: createUuid(), kind: 'file', name: file.name, resolve: async () => ({ name: file.name, content }) };
		}));
	} catch (error) {
		batch.abort();
		throw error;
	}
}

function readFile(file: File, signal: AbortSignal): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new CancellationError()); return; }
		const reader = new FileReader();
		const resources = new DisposableStore();
		const finish = (bytes?: Uint8Array, error?: unknown): void => {
			resources.dispose();
			if (bytes) resolve(bytes); else reject(error);
		};
		resources.add(addDisposableListener(reader, 'load', () => finish(new Uint8Array(reader.result as ArrayBuffer))));
		resources.add(addDisposableListener(reader, 'error', () => finish(undefined, reader.error)));
		resources.add(addDisposableListener(reader, 'abort', () => finish(undefined, new CancellationError())));
		resources.add(addDisposableListener(signal, 'abort', () => reader.abort()));
		try { reader.readAsArrayBuffer(file); } catch (error) { finish(undefined, error); }
	});
}
