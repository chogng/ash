import type { DocumentCodec, DocumentTextFormat } from '../common/documentCodec.js';
import type { URI } from '../../../../base/common/uri.js';
import type { RichTextEditorWidget } from '../../../../../../extensions/academic/browser/widget/richTextEditor/richTextEditorWidget.js';
import type { RichTextEditorOptions } from '../../../../../../extensions/academic/browser/widget/richTextEditor/richTextEditorWidget.js';
import type { DocumentNode } from '../../../../../../extensions/academic/common/model/document.js';
import type { DocumentOutlineOptions } from '../../../../../../extensions/academic/common/model/documentOutline.js';
import type { DocumentPlugin } from '../../../../../../extensions/academic/common/model/documentPlugin.js';
import type { DocumentSchema } from '../../../../../../extensions/academic/common/model/documentSchema.js';

/** Product-neutral schema and browser composition for one document kind. */
export interface EditorProfile {
	readonly codec: DocumentCodec;
	readonly widget: typeof RichTextEditorWidget;
	importText(text: string, format: DocumentTextFormat, schema: DocumentSchema, ownerDocument: Document, source: URI): DocumentNode;
	exportText(document: DocumentNode, schema: DocumentSchema, format: DocumentTextFormat): string;
	readonly contributions?: RichTextEditorOptions["contributions"];
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
