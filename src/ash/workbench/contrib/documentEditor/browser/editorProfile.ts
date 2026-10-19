import type { EditorProfile } from '../../../services/documentEditor/browser/documentEditorProfile.js';
import { DocumentEditorPane } from './documentEditorPane.js';
import type { EditorPaneCreationOptions } from '../../../browser/parts/editor/editorPane.js';
import { AppServerDocumentCollaborationService } from '../../../services/documentCollaboration/browser/appServerDocumentCollaborationService.js';
import { DocumentCollaborationService } from '../../../services/documentCollaboration/browser/documentCollaborationService.js';
import type { EditorPaneOptions } from "./documentEditorPane.js";

export interface EditorRuntimeOptions {
	readonly providerSignal?: AbortSignal;
	readonly modelCompatibility?: string;
	readonly onSave?: () => Promise<void | boolean>;
	readonly createDocumentCollaborationService?: EditorPaneOptions["createDocumentCollaborationService"];
}

/** Materializes one profile into pane options while keeping Workbench services at the composition root. */
export function createDocumentEditorPaneOptions(profile: EditorProfile, runtime: EditorRuntimeOptions = {}): EditorPaneOptions {
	const schema = profile.createSchema();
	return {
		...runtime,
		codec: profile.codec,
		widget: profile.widget,
		exportText: profile.exportText,
		contentType: profile.contentType,
		contributions: profile.contributions,
		editorId: profile.editorId,
		schema,
		...(profile.createEmptyDocument ? { createEmptyDocument: () => profile.createEmptyDocument!(schema) } : {}),
		...(profile.outline === undefined ? {} : { outline: profile.outline }),
		...(profile.outlineNavigator === undefined ? {} : { outlineNavigator: profile.outlineNavigator }),
		...(profile.nodeViews === undefined ? {} : { nodeViews: profile.nodeViews }),
		...(profile.inlineNodeViews === undefined ? {} : { inlineNodeViews: profile.inlineNodeViews }),
		...(profile.toolbarActions === undefined ? {} : { toolbarActions: profile.toolbarActions }),
		...(profile.createPlugins === undefined ? {} : { plugins: profile.createPlugins() }),
		...(profile.collaborationSchemaId === undefined ? {} : { collaborationSchemaId: profile.collaborationSchemaId }),
	};
}

/** Optional document packages reuse the Workbench model and collaboration owners. */
export function createDocumentEditorPane(profile: EditorProfile, options: EditorPaneCreationOptions, providerSignal?: AbortSignal, modelCompatibility?: string): DocumentEditorPane {
	const instantiationService = options.instantiationService;
	if (!instantiationService) throw new Error('Document editor requires the Workbench instantiation service');
	const paneOptions = createDocumentEditorPaneOptions(profile, {
		onSave: options.onSave,
		providerSignal,
		modelCompatibility,
		createDocumentCollaborationService: () => {
			const appServerService = options.documentCollaborationApi && options.serverEvents
				? new AppServerDocumentCollaborationService(options.documentCollaborationApi, options.serverEvents)
				: undefined;
			return instantiationService.createInstance(DocumentCollaborationService, appServerService);
		},
	});
	return instantiationService.createInstance(DocumentEditorPane, paneOptions);
}
