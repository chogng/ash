import { URI } from '../../../../base/common/uri.js';
import { generateUuid, isUuid } from '../../../../base/common/uuid.js';
import { FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';

/** Creates or reads the stable profile namespace for catalog registrations. */
export async function resolveArtifactCatalogIdentity(files: IFileService, profile: URI): Promise<string> {
	const home = URI.joinPath(profile, 'artifact-catalog');
	const resource = URI.joinPath(home, 'client-id');
	await files.createDirectory(home);
	try { await files.writeFile({ resource, content: generateUuid() }, { create: true, overwrite: false }); }
	catch (error) {
		if (toFileSystemProviderErrorCode(error instanceof Error ? error : undefined) !== FileSystemProviderErrorCode.FileExists) throw error;
	}
	const id = (await files.readFile(resource)).content;
	if (!isUuid(id)) throw new Error('Invalid artifact catalog identity');
	return id;
}
