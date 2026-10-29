import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { FileNotFoundError, type IFileService } from '../../../../platform/files/common/files.js';
import { getWebviewContentMimeType } from '../../../../platform/webview/common/mimeTypes.js';

/** Root checks narrow the existing file provider's grant; they never grant filesystem access. */
export async function loadLocalResource(
	requestUri: URI,
	options: { readonly roots: readonly URI[]; },
	fileService: IFileService,
	token: CancellationToken,
): Promise<{
	readonly status: number;
	readonly mimeType: string;
	readonly bytes?: Uint8Array;
}> {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	const resource = requestUri.with({ query: '', fragment: '' });
	const allowed = options.roots.some(root => {
		const directory = root.with({ query: '', fragment: '' });
		return extUriBiasedIgnorePathCase.isEqualOrParent(resource, directory) && !extUriBiasedIgnorePathCase.isEqual(resource, directory);
	});
	const mimeType = getWebviewContentMimeType(resource);
	if (!allowed) {
		return { status: 403, mimeType };
	}
	try {
		const content = await fileService.readFileBytes(resource);
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		return { status: 200, mimeType, bytes: content.bytes };
	} catch (error) {
		if (error instanceof FileNotFoundError) {
			return { status: 404, mimeType };
		}
		throw error;
	}
}
