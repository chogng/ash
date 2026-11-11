import type { URI } from '../../../../base/common/uri.js';
import type { LanguageWorkspaceEditEntry, LanguageTextDocumentEdit } from '../../../../editor/common/languages.js';
import { FileKind, FileNotFoundError, type IFileService } from '../../../../platform/files/common/files.js';
import { WorkspaceEditConflictError } from '../../../../editor/browser/services/bulkEditService.js';

interface FileOperation {
	readonly entry: Exclude<LanguageWorkspaceEditEntry, LanguageTextDocumentEdit>;
	readonly applies: boolean;
	readonly sourceBefore?: string;
	readonly targetBefore?: string;
	readonly binaryCreate?: { readonly contents: Uint8Array; readonly before?: Uint8Array; };
}

export function sameFileBytes(actual: Uint8Array, expected: Uint8Array): boolean {
	return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

/** File steps use serialized contents so their inverse preserves BOM and line endings. */
export class BulkFileEdits {
	constructor(
		private readonly operation: FileOperation,
		private readonly files: IFileService,
		private readonly inverses: (() => Promise<void>)[],
	) { }

	public async apply(): Promise<readonly URI[]> {
		const operation = this.operation;
		if (!operation.applies) {
			return [];
		}
		const entry = operation.entry;
		switch (entry.kind) {
			case 'create': {
				if (operation.binaryCreate) {
					const { contents, before } = operation.binaryCreate;
					const revision = before && await this.assertFileBytes(entry.resource, before);
					await this.files.writeFileBytes(entry.resource, contents, { create: !before, overwrite: !!before, expectedRevision: revision });
					this.inverses.push(async () => {
						const revision = await this.assertFileBytes(entry.resource, contents);
						if (before) await this.files.writeFileBytes(entry.resource, before, { create: false, overwrite: true, expectedRevision: revision });
						else await this.files.delete(entry.resource, 'ignore', 'fileOrEmptyDirectory');
					});
					return [entry.resource];
				}
				await this.files.createFile(entry.resource, entry.existing);
				let written = '';
				this.inverses.push(async () => {
					await this.assertFileText(entry.resource, written);
					if (operation.targetBefore === undefined) {
						await this.files.delete(entry.resource, 'ignore', 'fileOrEmptyDirectory');
					} else {
						await this.files.writeFile({ resource: entry.resource, content: operation.targetBefore });
					}
				});
				if (entry.contents !== undefined) {
					const empty = await this.files.readFile(entry.resource);
					await this.files.writeFile({ resource: entry.resource, content: entry.contents, expectedRevision: empty.revision });
					written = entry.contents;
				}
				return [entry.resource];
			}
			case 'rename': {
				await this.files.rename(entry.source, entry.target, entry.existing);
				this.inverses.push(async () => {
					await this.assertFileText(entry.target, operation.sourceBefore!);
					await this.files.rename(entry.target, entry.source, 'overwrite');
					if (operation.targetBefore !== undefined) {
						await this.files.writeFile({ resource: entry.target, content: operation.targetBefore });
					}
				});
				return [entry.source, entry.target];
			}
			case 'delete': {
				await this.files.delete(entry.resource, entry.missing, entry.mode);
				this.inverses.push(async () => {
					await this.assertFileText(entry.resource, undefined);
					await this.files.createFile(entry.resource, 'overwrite');
					await this.files.writeFile({ resource: entry.resource, content: operation.sourceBefore! });
				});
				return [entry.resource];
			}
		}
	}

	private async assertFileBytes(resource: URI, expected: Uint8Array): Promise<string> {
		const actual = await this.files.readFileBytes(resource);
		if (!sameFileBytes(actual.bytes, expected)) {
			throw new WorkspaceEditConflictError(`Workspace edit target '${resource.toString()}' changed before replacement`);
		}
		return actual.revision;
	}

	private async assertFileText(resource: URI, expected: string | undefined): Promise<void> {
		let actual: string | undefined;
		try {
			if ((await this.files.stat(resource)).kind !== FileKind.File) {
				throw new WorkspaceEditConflictError(`Workspace edit target '${resource.toString()}' is no longer a regular file`);
			}
			actual = (await this.files.readFile(resource)).content;
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) {
				throw error;
			}
		}
		if (actual !== expected) {
			throw new WorkspaceEditConflictError(`Workspace edit target '${resource.toString()}' changed before replacement`);
		}
	}
}
