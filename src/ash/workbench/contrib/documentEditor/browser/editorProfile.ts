import type { IResourceEditorInput } from '../../../common/editor.js';
import type { RichTextEditorOptions } from "../../../../editor/browser/widget/richTextEditor/richTextEditorWidget.js";
import type { DocumentNode } from "../../../../editor/common/model/document.js";
import type { DocumentOutlineOptions } from "../../../../editor/common/model/documentOutline.js";
import type { DocumentPlugin } from "../../../../editor/common/model/documentPlugin.js";
import type { DocumentSchema } from "../../../../editor/common/model/documentSchema.js";
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import type { EditorPaneOptions } from "./documentEditorPane.js";
import { matchDocumentEditor, type EditorInputMatcher } from "./documentEditorInput.js";
import { DocumentTypes } from '../../../services/documentEditor/common/documentTypes.js';

/** Product-neutral schema and browser composition for one document kind. */
export interface EditorProfile {
	readonly id: string;
	readonly contentType: string;
	readonly input: EditorInputMatcher;
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

const profiles: EditorProfile[] = [];

/** Document types and their editing configuration are registered together before file restoration. */
export function registerEditorProfile(profile: EditorProfile): void {
	DocumentTypes.register({ id: profile.id, contentType: profile.contentType, extensions: profile.input.extensions ?? [] });
	profiles.push(profile);
}

export function getEditorProfiles(): readonly EditorProfile[] { return profiles; }

/** Selects the first profile that claims one Workbench input. */
export function findEditorProfile(input: IResourceEditorInput, profiles: readonly EditorProfile[]): EditorProfile | undefined {
	return profiles.find(profile => matchDocumentEditor(input, profile.input) !== EditorPaneMatch.None);
}

/** Produces the editor-pane match used by a profile registry contribution. */
export function matchEditorProfiles(input: IResourceEditorInput, profiles: readonly EditorProfile[]): EditorPaneMatch {
	return findEditorProfile(input, profiles) ? EditorPaneMatch.Default : EditorPaneMatch.None;
}

/** Materializes one profile into pane options while keeping Workbench services at the composition root. */
export function createDocumentEditorPaneOptions(profile: EditorProfile, runtime: EditorRuntimeOptions = {}): EditorPaneOptions {
	const schema = profile.createSchema();
	return {
		...runtime,
		contentType: profile.contentType,
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
