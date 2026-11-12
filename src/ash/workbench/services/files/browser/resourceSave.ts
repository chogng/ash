import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { getExtensionForMimeType, getMediaOrTextMime, normalizeMimeType } from '../../../../base/common/mime.js';
import { isNative } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

export function resourceFileName(name: string, mimeType: string): string {
	const safeName = name.split(/[\\/]/u).at(-1)?.replace(/[<>:"|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '') || 'download';
	const type = normalizeMimeType(mimeType).split(';', 1)[0]!;
	const extension = getExtensionForMimeType(type);
	return extension && getMediaOrTextMime(safeName) !== type ? safeName + extension : safeName;
}

/** Save existing or exported bytes using the destination policy of the caller's action. */
export async function saveResourceAs(
	accessor: ServicesAccessor,
	content: Blob | Uint8Array,
	name: string,
	document: Document,
	options: { readonly signal?: AbortSignal; readonly download?: boolean; readonly selectTarget?: () => Promise<URI | undefined>; } = {},
): Promise<void> {
	if (options.signal?.aborted) return;
	if (options.download || !isNative && !options.selectTarget) {
		const blob = content instanceof Uint8Array ? new Blob([new Uint8Array(content)]) : content;
		triggerDownload(blob, name, document);
		return;
	}
	const files = accessor.get(IFileService);
	const target = await (options.selectTarget?.() ?? accessor.get(IFileDialogService).pickFileToSave(URI.file('/' + name)));
	if (!target || options.signal?.aborted) return;
	const bytes = content instanceof Uint8Array ? content : new Uint8Array(await content.arrayBuffer());
	if (!options.signal?.aborted) await files.writeFileBytes(target, bytes, { create: true, overwrite: true });
}
