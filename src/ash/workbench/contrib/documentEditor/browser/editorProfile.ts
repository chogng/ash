import { DocumentEditorPane } from './documentEditorPane.js';
import type { EditorPaneCreationOptions } from '../../../browser/parts/editor/editorPane.js';
import { AppServerDocumentCollaborationService } from '../../../services/documentCollaboration/browser/appServerDocumentCollaborationService.js';
import { DocumentCollaborationService } from '../../../services/documentCollaboration/browser/documentCollaborationService.js';
import type { RichTextEditorOptions } from "../../../../editor/browser/widget/richTextEditor/richTextEditorWidget.js";
import type { DocumentNode } from "../../../../editor/common/model/document.js";
import type { DocumentOutlineOptions } from "../../../../editor/common/model/documentOutline.js";
import type { DocumentPlugin } from "../../../../editor/common/model/documentPlugin.js";
import type { DocumentSchema } from "../../../../editor/common/model/documentSchema.js";
import type { EditorPaneOptions } from "./documentEditorPane.js";

/** Product-neutral schema and browser composition for one document kind. */
export interface EditorProfile {
	readonly editorId?: string;
	readonly id: string;
	readonly contentType: string;
	readonly createSchema: () => DocumentSchema;
	readonly createEmptyDocument?: (schema: DocumentSchema) => DocumentNode;
	readonly outline?: DocumentOutlineOptions;
	readonly outlineNavigator?: boolean;
	readonly nodeViews?: RichTextEditorOptions["nodeViews"];
	readonly inlineNodeViews?: RichTextEditorOptions["inlineNodeViews"];
	readonly toolbarActions?: RichTextEditorOptions["toolbarActions"];
	readonly createPlugins?: () => readonly DocumentPlugin<unknown>[];
	/** Stable compatibility ID for documents that join the same collaboration room. */
	readonly collaborationSchemaId?: string;
}

export interface EditorRuntimeOptions {
	readonly onSave?: () => Promise<void | boolean>;
	readonly createDocumentCollaborationService?: EditorPaneOptions["createDocumentCollaborationService"];
}

/** Materializes one profile into pane options while keeping Workbench services at the composition root. */
export function createDocumentEditorPaneOptions(profile: EditorProfile, runtime: EditorRuntimeOptions = {}): EditorPaneOptions {
	const schema = profile.createSchema();
	return {
		...runtime,
		contentType: profile.contentType,
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
export function createDocumentEditorPane(profile: EditorProfile, options: EditorPaneCreationOptions): DocumentEditorPane {
	const instantiationService = options.instantiationService;
	if (!instantiationService) throw new Error('Document editor requires the Workbench instantiation service');
	const paneOptions = createDocumentEditorPaneOptions(profile, {
		onSave: options.onSave,
		createDocumentCollaborationService: () => {
			const appServerService = options.documentCollaborationApi && options.serverEvents
				? new AppServerDocumentCollaborationService(options.documentCollaborationApi, options.serverEvents)
				: undefined;
			return instantiationService.createInstance(DocumentCollaborationService, appServerService);
		},
	});
	return instantiationService.createInstance(DocumentEditorPane, paneOptions);
}
