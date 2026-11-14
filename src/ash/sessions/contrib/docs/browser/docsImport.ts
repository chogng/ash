import { createDefaultDocumentSchema } from '../../../../../../extensions/academy/common/model/documentSchema.js';
import { deserializeDocument } from '../../../../../../extensions/academy/common/model/documentSerialization.js';
import { exportDocumentText, importDocumentText, materializeDocumentImages } from '../../../../../../extensions/academy/browser/documentImportExport.js';
import { createDocumentFragmentFromHtml } from '../../../../../../extensions/academy/browser/widget/richTextEditor/htmlDocumentFragment.js';
import type { DocumentNode, DocumentTextFormat } from '../../../../workbench/services/documentEditor/common/documentCodec.js';
import type { URI } from '../../../../base/common/uri.js';

/** The legacy schema owns validation and rejects formatting Markdown cannot preserve. */
export function legacyDocsToMarkdown(serialized: string): string {
	// Empty files were valid blank documents in the legacy codec.
	if (serialized.trim().length === 0) return '';
	const schema = createDefaultDocumentSchema();
	return exportDocumentText(deserializeDocument(serialized, schema), schema, 'markdown');
}

export function documentToDocsMarkdown(document: DocumentNode): string {
	return exportDocumentText(document, createDefaultDocumentSchema(), 'markdown');
}

/** HTML writing blocks share the existing paste sanitizer and conversion semantics. */
export function importDocsHtml(html: string, ownerDocument: Document): string | undefined {
	const schema = createDefaultDocumentSchema();
	const fragment = createDocumentFragmentFromHtml(ownerDocument, schema, html);
	return fragment && exportDocumentText(schema.createDocument(fragment.content), schema, 'markdown');
}

export async function importDocsText(text: string, format: DocumentTextFormat, ownerDocument: Document, resource: URI, readResource: (resource: URI) => Promise<Uint8Array>): Promise<string> {
	const schema = createDefaultDocumentSchema();
	const document = await materializeDocumentImages(importDocumentText(text, format, schema, ownerDocument, resource), readResource);
	return exportDocumentText(document, schema, 'markdown');
}
