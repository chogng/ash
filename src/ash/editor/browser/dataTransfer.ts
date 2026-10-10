import { DataTransfers } from '../../base/browser/dnd.js';
import { createFileDataTransferItem, createStringDataTransferItem, IDataTransferItem, UriList, VSDataTransfer } from '../../base/common/dataTransfer.js';
import { getExtensionForMimeType, isTextStreamMime, Mimes, normalizeMimeType } from '../../base/common/mime.js';
import { URI } from '../../base/common/uri.js';
import type { IClipboardItem } from '../../platform/clipboard/common/clipboardService.js';
import { CodeDataTransfers, getPathForFile } from '../../platform/dnd/browser/dnd.js';

export function toVSDataTransfer(dataTransfer: DataTransfer): VSDataTransfer;
export function toVSDataTransfer(dataTransfer: readonly IClipboardItem[]): VSDataTransfer;
export function toVSDataTransfer(dataTransfer: DataTransfer | readonly IClipboardItem[]): VSDataTransfer {
	const result = new VSDataTransfer();
	if (!('items' in dataTransfer)) {
		for (const { type, data } of dataTransfer) {
			const mime = normalizeMimeType(type, true)?.split(';', 1)[0];
			// Clipboard events also carry legacy string identifiers that are not MIME types.
			if (!mime || mime.startsWith('text/') || /^application\/(?:json|xml|javascript|[^/]+\+(?:json|xml))$/.test(mime) || isTextStreamMime(mime)) {
				result.append(type, createStringDataTransferItem(new TextDecoder().decode(data)));
				continue;
			}
			const file = createFileDataTransferItem(`clipboard${getExtensionForMimeType(type) ?? '.bin'}`, undefined, async () => data);
			result.append(type, {
				...file,
				// Custom formats can contain text. Decode only when requested and never replace invalid bytes.
				async asString() {
					try {
						return new TextDecoder('utf-8', { fatal: true }).decode(data);
					} catch {
						return '';
					}
				},
			});
		}
		return result;
	}
	for (const item of dataTransfer.items) {
		if (item.kind === 'string') {
			result.append(item.type, createStringDataTransferItem(new Promise(resolve => item.getAsString(resolve))));
			continue;
		}
		const file = item.kind === 'file' ? item.getAsFile() : null;
		if (file) result.append(item.type, createFileDataTransferItemFromFile(file));
	}
	return result;
}

function createFileDataTransferItemFromFile(file: File): IDataTransferItem {
	const path = getPathForFile(file);
	return createFileDataTransferItem(file.name, path ? URI.file(path) : undefined, async () => new Uint8Array(await file.arrayBuffer()));
}

const INTERNAL_DND_MIME_TYPES = Object.freeze([
	CodeDataTransfers.EDITORS,
	CodeDataTransfers.FILES,
	DataTransfers.RESOURCES,
	DataTransfers.INTERNAL_URI_LIST,
]);

export function toExternalVSDataTransfer(sourceDataTransfer: DataTransfer, overwriteUriList = false): VSDataTransfer {
	const result = toVSDataTransfer(sourceDataTransfer);
	const internalUriList = result.get(DataTransfers.INTERNAL_URI_LIST);
	if (internalUriList) result.replace(Mimes.uriList, internalUriList);
	else if (overwriteUriList || !result.has(Mimes.uriList)) {
		const resources: string[] = [];
		for (const item of sourceDataTransfer.items) {
			const file = item.getAsFile();
			if (!file) continue;
			const path = getPathForFile(file);
			if (path) {
				resources.push(URI.file(path).toString());
			}
		}
		if (resources.length > 0) result.replace(Mimes.uriList, createStringDataTransferItem(UriList.create(resources)));
	}

	for (const internal of INTERNAL_DND_MIME_TYPES) {
		result.delete(internal);
	}
	return result;
}
