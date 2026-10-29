import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { raceCancellationError } from '../../../src/ash/base/common/async.js';
import { streamToBuffer } from '../../../src/ash/base/common/buffer.js';
import { CancellationTokenSource } from '../../../src/ash/base/common/cancellation.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import type { IFileService } from '../../../src/ash/platform/files/common/files.js';

/** Loads PDF bytes for the Workbench PDF.js renderer. */
export interface IPdfDocumentLoader {
	load(input: IResourceEditorInput, signal: AbortSignal): Promise<Uint8Array>;
}

/** Reads PDF bytes through the workspace-confined file service. */
export class WorkspacePdfDocumentLoader implements IPdfDocumentLoader {
	constructor(private readonly fileService: IFileService) {}

	async load(input: IResourceEditorInput, signal: AbortSignal): Promise<Uint8Array> {
		signal.throwIfAborted();
		if (input.initialBytes && input.readOnly) return input.initialBytes.slice();
		using cancellation = new CancellationTokenSource();
		using subscription = addDisposableListener(signal, 'abort', () => cancellation.cancel(), { once: true });
		if (signal.aborted) {
			cancellation.cancel();
		}
		const content = await this.fileService.readFileStream(input.resource, {}, cancellation.token);
		try {
			return (
				await raceCancellationError(
					streamToBuffer(content.value),
					cancellation.token,
					'PDF document loading was cancelled',
				)
			).buffer;
		} finally {
			content.value.destroy();
		}
	}
}
