import type { EditorProfile } from '../../../services/documentEditor/browser/documentEditorProfile.js';
import { DocumentEditorPane } from './documentEditorPane.js';
import type { EditorPaneCreationOptions } from '../../../browser/parts/editor/editorPane.js';
import { AppServerDocumentCollaborationService } from '../../../services/documentCollaboration/browser/appServerDocumentCollaborationService.js';
import { DocumentCollaborationService } from '../../../services/documentCollaboration/browser/documentCollaborationService.js';
import type { EditorPaneOptions } from './documentEditorPane.js';

export interface EditorRuntimeOptions {
	readonly providerSignal?: AbortSignal;
	readonly modelCompatibility?: string;
	readonly onSave?: () => Promise<void | boolean>;
	readonly createDocumentCollaborationService?: EditorPaneOptions['createDocumentCollaborationService'];
}

/** Materializes one profile into pane options while keeping Workbench services at the composition root. */
export function createDocumentEditorPaneOptions(profile: EditorProfile, runtime: EditorRuntimeOptions = {}): EditorPaneOptions {
	return {
		...profile.create(), ...runtime, editorId: profile.editorId, contentType: profile.contentType,
		collaborationSchemaId: profile.collaborationSchemaId,
	};
}

/** Product presentations and installed clients share the same document and collaboration services. */
export function resolveDocumentPaneOptions(profile: EditorProfile, options: EditorPaneCreationOptions, providerSignal?: AbortSignal, modelCompatibility?: string): EditorPaneOptions {
	const instantiationService = options.instantiationService;
	if (!instantiationService) throw new Error('Document editor requires the Workbench instantiation service');
	return createDocumentEditorPaneOptions(profile, {
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
}

export function createDocumentEditorPane(profile: EditorProfile, options: EditorPaneCreationOptions, providerSignal?: AbortSignal, modelCompatibility?: string): DocumentEditorPane {
	const paneOptions = resolveDocumentPaneOptions(profile, options, providerSignal, modelCompatibility);
	return options.instantiationService!.createInstance(DocumentEditorPane, paneOptions);
}
