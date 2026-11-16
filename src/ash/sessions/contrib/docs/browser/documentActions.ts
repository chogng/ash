import { getArtifactDraftHome } from '../../artifact/browser/artifactStorage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { IWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { artifactDetailEntry } from '../../artifact/common/artifactWorkspace.js';
import { createArkdownDocsInput } from './docsEditorInput.js';

export async function createDocsDocument(accessor: ServicesAccessor, title = localize('document.untitled', 'Untitled')): Promise<void> {
	await createDocsOpener(accessor)(newDocsResource(title));
}

const activeDocsKey = 'sessions.docs.activeDocument';

export function restoredDocsResource(storage: IStorageService): URI | undefined {
	const saved = storage.get(activeDocsKey, StorageScope.WORKSPACE);
	if (!saved) return undefined;
	const resource = URI.parse(saved);
	if (![Schemas.file, Schemas.untitled, Schemas.vscodeUserData].includes(resource.scheme) || !/\.md$/iu.test(resource.path)) return undefined;
	return resource;
}

export function newDocsResource(name: string): URI {
	return URI.from({ scheme: 'untitled', path: `/${generateUuid()}/${name}.md` });
}

export function createDocsOpener(accessor: ServicesAccessor) {
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ISessionsEntryService);
	const instantiation = accessor.get(IInstantiationService);
	const remember = (resource: URI) => storage.store(activeDocsKey, resource.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	return async (resource: URI, options: { source?: 'restore'; label?: string; initialText?: string; } = {}) => {
		if (!/\.md$/iu.test(resource.path)) throw new Error(localize({ bundle: 'ash.docs', key: 'unsupportedImport' }, 'This document contains content that Docs cannot import.'));
		const draftSource = resource.scheme === Schemas.untitled ? resource : undefined;
		// Chat drafts have an internal file identity before editing; export chooses a separate destination.
		if (resource.scheme === Schemas.untitled) {
			const { files, profiles, workspace, backups } = instantiation.invokeFunction(accessor => ({
				files: accessor.get(IFileService), profiles: accessor.get(IUserDataProfileService),
				workspace: accessor.get(IWorkspaceContextService), backups: accessor.get(IWorkingCopyBackupService),
			}));
			const backup = await backups.resolve(resource);
			const content = options.initialText ?? backup?.content ?? '';
			const home = URI.joinPath(getArtifactDraftHome(profiles.currentProfile.location, workspace.getWorkspace().id), 'docs', generateUuid());
			await files.createDirectory(home);
			const target = URI.joinPath(home, basename(resource));
			await files.writeFile({ resource: target, content });
			options = { ...options, label: options.label ?? basename(resource), initialText: undefined };
			resource = target;
		}
		const source = { resource, label: options.label, initialText: options.initialText };
		const input = createArkdownDocsInput(source);
		const entry = {
			...artifactDetailEntry, id: 'docs',
			restoreCommand: 'sessions.restore.docs',
			editorInput: input,
			onEditorInputReplaced: (previous: IResourceEditorInput, replacement: IResourceEditorInput) => {
				if (storage.get(activeDocsKey, StorageScope.WORKSPACE) === previous.resource.toString()) remember(replacement.resource);
			},
		} as const;
		await layout.openEntry(entry, () => {
			remember(input.resource);
			return entry;
		}, { source: options.source });
		if (draftSource) {
			await storage.flush();
			await instantiation.invokeFunction(accessor => accessor.get(IWorkingCopyBackupService)).delete(draftSource);
		}
	};
}
