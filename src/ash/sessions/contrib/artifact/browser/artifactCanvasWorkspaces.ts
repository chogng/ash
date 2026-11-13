import { isUuid } from '../../../../base/common/uuid.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { openArtifactWorkspace } from './artifactWorkspaceOpener.js';
import { getArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import { mountArtifactWorkspace } from './artifactWorkspace.js';
import type { DesignDocumentController } from './designDocumentController.js';
import { IDesignEditorService } from './designEditorService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

export const OPEN_CANVAS_ARTIFACT = 'sessions.creator.openCanvasArtifact';

CommandsRegistry.register(OPEN_CANVAS_ARTIFACT, (accessor, id) => {
	const document = isUuid(id) ? accessor.get(IDesignEditorService).artifactDocuments.get().get(id) : undefined;
	if (document) return openManagedCanvasArtifact(accessor, document);
});

export function openManagedCanvasArtifact(accessor: ServicesAccessor, document: DesignDocumentController): Promise<void> {
	return openArtifactWorkspace(accessor, {
		key: `canvas:${document.model.value.documentId}`, entryId: document.artifactKind ?? document.mode, title: document.name,
		help: getArtifactWorkspace(document.mode)?.help,
		mount: (instantiation, container) => mountArtifactWorkspace(instantiation, container, document.mode, undefined, document),
	});
}
