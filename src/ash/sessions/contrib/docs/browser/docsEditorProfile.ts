import { createGeneralDocumentProfile } from '../../../../../../extensions/academy/browser/generalProfile.js';
import { createDefaultDocumentSchema } from '../../../../../../extensions/academy/common/model/documentSchema.js';
import { createDocumentFragmentFromHtml } from '../../../../../../extensions/academy/browser/widget/richTextEditor/htmlDocumentFragment.js';
import type { DocumentNode } from '../../../../workbench/services/documentEditor/common/documentCodec.js';

/** Docs owns its flowing document presentation; the shared rich-text engine owns editing semantics. */
export const docsEditorProfile = createGeneralDocumentProfile(true);

/** Import writing blocks through the rich editor's schema and paste sanitizer. */
export function importDocsHtml(html: string, ownerDocument: Document): DocumentNode | undefined {
	const schema = createDefaultDocumentSchema();
	const fragment = createDocumentFragmentFromHtml(ownerDocument, schema, html);
	return fragment && schema.createDocument(fragment.content);
}
