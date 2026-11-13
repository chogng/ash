import { isUuid } from '../../../../base/common/uuid.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import type { ArtifactKind } from '../../../common/artifactKind.js';
import { openArtifactWorkspace } from './artifactWorkspaceOpener.js';
import { getArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import { mountArtifactWorkspace, type ArtifactDesignExample } from './artifactWorkspace.js';
import type { DesignDocumentController } from './designDocumentController.js';
import { IDesignEditorService } from './designEditorService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

export const OPEN_ARTIFACT_DESIGN = 'sessions.creator.openCanvasArtifact';

CommandsRegistry.register(OPEN_ARTIFACT_DESIGN, (accessor, id) => {
	const document = isUuid(id) ? accessor.get(IDesignEditorService).artifactDocuments.get().get(id) : undefined;
	if (document) return openManagedArtifactDesign(accessor, document);
});

export function openArtifactDesignExample(accessor: ServicesAccessor, kind: ArtifactKind, mode: ArtifactWorkspaceId, example: ArtifactDesignExample): Promise<void> {
	return openArtifactWorkspace(accessor, {
		key: `example:${kind}`, entryId: kind, title: example.title, help: getArtifactWorkspace(mode)?.help,
		mount: (instantiation, container) => mountArtifactWorkspace(instantiation, container, mode, example),
	});
}

export function openManagedArtifactDesign(accessor: ServicesAccessor, document: DesignDocumentController): Promise<void> {
	return openArtifactWorkspace(accessor, {
		key: `canvas:${document.model.value.documentId}`, entryId: document.artifactKind ?? document.mode, title: document.name,
		help: getArtifactWorkspace(document.mode)?.help,
		mount: (instantiation, container) => mountArtifactWorkspace(instantiation, container, document.mode, undefined, document),
	});
}
