import { Event } from '../../../../base/common/event.js';
import { observableFromEvent } from '../../../../base/common/observable.js';
import { artifactCanvasModes, openArtifactCommands, type ArtifactCanvasKind } from '../common/artifactWorkspace.js';
import { getArtifactTitle } from './artifactKindPresentation.js';
import { registerArtifactCatalogSource } from './artifactWorkspaceRegistry.js';
import type { ArtifactCanvasDocumentController } from './artifactCanvasDocumentController.js';
import { IArtifactCanvasEditorService } from './artifactCanvasEditorService.js';

/** Lists a mode's retained working copy alongside individually saved canvas artifacts. */
export function registerArtifactCanvasDocument(kind: ArtifactCanvasKind, detail: (document: ArtifactCanvasDocumentController) => string): void {
	registerArtifactCatalogSource(accessor => {
		const mode = artifactCanvasModes[kind];
		const document = accessor.get(IArtifactCanvasEditorService).getDocument(mode);
		const changed = Event.any(document.onDidChangeContent, document.onDidChangeLabel, document.onDidChange);
		return {
			cards: observableFromEvent(document, changed, () => document.model.value.shapes.length === 0 ? [] : [{
				title: document.name, kind, detail: detail(document), owner: 'you' as const, resource: document.savedResource, createdAt: document.model.value.createdAt,
				command: { id: 'sessions.artifacts.openMode', args: [mode] },
			}]),
			isRestoring: observableFromEvent(document, document.onDidChange, () => document.isRestoring),
		};
	});
}

registerArtifactCatalogSource(accessor => {
	const canvases = accessor.get(IArtifactCanvasEditorService);
	void canvases.loadArtifactDocuments();
	return {
		cards: canvases.artifactDocuments.map(artifacts => [...artifacts].flatMap(([id, document]) => {
			const kind = document.artifactKind;
			return kind === undefined ? [] : [{
				title: document.name, kind, detail: getArtifactTitle(kind), owner: 'you' as const, resource: document.savedResource, createdAt: document.model.value.createdAt,
				workspaceKey: `canvas:${id}`,
				command: { id: openArtifactCommands.canvas, args: [id] },
			}];
		})),
	};
});
