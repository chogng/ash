import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { FileRevisionConflictError, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode, type IFileBytes } from '../../../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { type EditSession, type EditSessionSlot, editSessionSizeLimit, type IEditSessionsStorageService, parseEditSession } from '../common/editSessions.js';

/** The latest saved handoff in each local repository belongs to the current Ash profile. */
export class EditSessionsWorkbenchService implements IEditSessionsStorageService {
	constructor(
		@IFileService private readonly files: IFileService,
		@IUserDataProfileService private readonly profiles: IUserDataProfileService,
	) { }

	async read(repositoryId: string): Promise<EditSessionSlot> {
		const location = this.location(repositoryId);
		let file: IFileBytes;
		try {
			file = await this.files.readFileBytes(location, { size: editSessionSizeLimit });
		} catch (error) {
			if (error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
				return { kind: 'empty', revision: undefined };
			}
			throw new Error(localize('editSessions.readFailed', 'Could not read the saved working changes.'), { cause: error });
		}
		const { bytes, revision } = file;
		if (!bytes.length) return { kind: 'empty', revision };
		try {
			return { kind: 'saved', session: parseEditSession(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), revision };
		} catch (error) {
			return { kind: 'invalid', error, revision };
		}
	}

	async write(repositoryId: string, session: EditSession, expectedRevision: string | undefined): Promise<void> {
		// A new save owns a new revision even when its file contents are identical.
		const bytes = new TextEncoder().encode(JSON.stringify({ ...session, id: generateUuid() }));
		if (bytes.byteLength > editSessionSizeLimit) {
			throw new Error(localize('editSessions.sizeLimit', 'The working changes are too large to save.'));
		}
		const location = this.location(repositoryId);
		await this.files.createDirectory(URI.joinPath(this.profiles.currentProfile.location, 'editSessions'));
		try {
			await this.files.writeFileBytes(location, bytes, {
				create: expectedRevision === undefined,
				overwrite: expectedRevision !== undefined,
				expectedRevision,
			});
		} catch (error) {
			if (error instanceof FileRevisionConflictError || error instanceof Error &&
				[FileSystemProviderErrorCode.FileExists, FileSystemProviderErrorCode.FileNotFound].includes(toFileSystemProviderErrorCode(error))) {
				throw new Error(localize('editSessions.savedChanged', 'The saved working changes changed in another window. Run the command again.'), { cause: error });
			}
			throw error;
		}
	}

	async clear(repositoryId: string, expectedRevision: string): Promise<boolean> {
		const location = this.location(repositoryId);
		try {
			// Profile writes serialize the revision check and publication across windows.
			// An empty slot releases the saved contents through that same write path.
			await this.files.writeFileBytes(location, new Uint8Array(), { create: false, overwrite: true, expectedRevision });
			return true;
		} catch (error) {
			if (error instanceof FileRevisionConflictError || error instanceof Error &&
				toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
				return false;
			}
			throw error;
		}
	}

	private location(repositoryId: string): URI {
		if (!/^[a-f0-9]{64}$/u.test(repositoryId)) {
			throw new TypeError('Invalid local Git repository ID');
		}
		return URI.joinPath(this.profiles.currentProfile.location, 'editSessions', `${repositoryId}.json`);
	}
}
