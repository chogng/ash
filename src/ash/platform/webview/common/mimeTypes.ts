import { getMediaOrTextMime, Mimes } from '../../../base/common/mime.js';
import type { URI } from '../../../base/common/uri.js';

export function getWebviewContentMimeType(resource: URI): string {
	return getMediaOrTextMime(resource.path) ?? Mimes.binary;
}
