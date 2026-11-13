import { isUuid } from '../../../../base/common/uuid.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { openArtifactWorkspace } from './artifactWorkspaceOpener.js';
import { getArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import { mountArtifactWorkspace } from './artifactWorkspace.js';
import type { ArtifactCanvasDocumentController } from './artifactCanvasDocumentController.js';
import { IArtifactCanvasEditorService } from './artifactCanvasEditorService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { openArtifactCommands } from '../common/artifactWorkspace.js';

CommandsRegistry.register(openArtifactCommands.canvas, async (accessor, id) => {
	if (!isUuid(id)) return false;
	const canvases = accessor.get(IArtifactCanvasEditorService);
	const instantiation = accessor.get(IInstantiationService);
	await canvases.loadArtifactDocuments();
	const document = canvases.artifactDocuments.get().get(id);
	if (!document) return false;
	await instantiation.invokeFunction(accessor => openManagedCanvasArtifact(accessor, document));
	return true;
});

export function openManagedCanvasArtifact(accessor: ServicesAccessor, document: ArtifactCanvasDocumentController): Promise<void> {
	return openArtifactWorkspace(accessor, {
		key: `canvas:${document.model.value.documentId}`, entryId: document.artifactKind ?? document.mode, title: document.name,
		help: getArtifactWorkspace(document.mode)?.help,
		mount: (instantiation, container) => mountArtifactWorkspace(instantiation, container, document.mode, document),
	});
}
