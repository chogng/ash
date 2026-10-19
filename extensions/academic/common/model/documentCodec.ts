import type { DocumentCodec } from '../../../../src/ash/workbench/services/documentEditor/common/documentCodec.js';
import { DocumentTextModel } from './documentTextModel.js';
import { deserializeDocument, serializeDocument, documentToPlainText } from './documentSerialization.js';
import { deserializeDocumentTransaction, serializeDocumentTransaction } from './documentTransactionSerialization.js';

/** Versioned Academy persistence and collaboration formats, independent of host transport. */
export const documentCodec: DocumentCodec = Object.freeze<DocumentCodec>({
	createModel: (schema, document, plugins) => DocumentTextModel.create(schema, document, { plugins }),
	parse: (text, schema, createEmptyDocument) => {
		if (text.trim().length === 0) {
			const document = createEmptyDocument?.() ?? schema.createDocument([]);
			schema.validate(document);
			return document;
		}
		return deserializeDocument(text, schema);
	},
	serialize: serializeDocument,
	deserialize: deserializeDocument,
	serializeTransaction: serializeDocumentTransaction,
	deserializeTransaction: deserializeDocumentTransaction,
	toPlainText: documentToPlainText,
});
