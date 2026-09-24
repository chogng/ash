import { DataTransfers } from '../../base/browser/dnd.js';
import { createFileDataTransferItem, createStringDataTransferItem, IDataTransferItem, UriList, VSDataTransfer } from '../../base/common/dataTransfer.js';
import { Mimes } from '../../base/common/mime.js';
import { URI } from '../../base/common/uri.js';
import { CodeDataTransfers, getPathForFile } from '../../platform/dnd/browser/dnd.js';
export function toVSDataTransfer(dataTransfer: DataTransfer): VSDataTransfer {
	const result = new VSDataTransfer();
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
			try { resources.push(path ? URI.file(path).toString() : URI.parse(file.name, true).toString()); } catch { }
		}
		if (resources.length > 0) result.replace(Mimes.uriList, createStringDataTransferItem(UriList.create(resources)));
	}

	for (const internal of INTERNAL_DND_MIME_TYPES) {
		result.delete(internal);
	}
	return result;
}
