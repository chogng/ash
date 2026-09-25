import type { URI } from '../../../../base/common/uri.js';
import { FileKind, type IFileEntry } from '../../../../platform/files/common/files.js';

/** One resource shown in the workspace file tree. */
export class ExplorerItem {
	constructor(
		public readonly resource: URI,
		public readonly name: string,
		public readonly kind: FileKind,
		public readonly children?: readonly ExplorerItem[],
	) {}

	public static fromFileEntry(entry: IFileEntry): ExplorerItem {
		return new ExplorerItem(entry.resource, entry.name, entry.kind);
	}
}
