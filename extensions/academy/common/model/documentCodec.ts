import type { DocumentCodec } from 'ash:editor/workbench/services/documentEditor/common/documentCodec.js';
import type { DocumentSchema } from './documentSchema.js';
import type { DocumentNode } from './document.js';
import type { DocumentPlugin } from './documentPlugin.js';
import { DocumentTextModel } from './documentTextModel.js';
import { deserializeDocument, serializeDocument, documentToPlainText } from './documentSerialization.js';
import {
	deserializeDocumentTransaction,
	serializeDocumentTransaction,
	DOCUMENT_TRANSACTION_SERIALIZATION_FORMAT,
	DOCUMENT_TRANSACTION_SERIALIZATION_VERSION,
} from './documentTransactionSerialization.js';

/** Versioned Academy persistence and collaboration formats, independent of host transport. */
export const documentCodec = Object.freeze({
	createModel: (schema: DocumentSchema, document: DocumentNode, plugins?: readonly DocumentPlugin<unknown>[]) => DocumentTextModel.create(schema, document, { plugins }),
	parse: (text: string, schema: DocumentSchema, createEmptyDocument?: () => DocumentNode) => {
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

/** The host receives capabilities bound to this package's semantic owner, never its schema or plugins. */
export function bindDocumentCodec(schema: DocumentSchema, plugins?: readonly DocumentPlugin<unknown>[]): DocumentCodec {
	return Object.freeze<DocumentCodec>({
		documentType: schema.documentType,
		createModel: document => documentCodec.createModel(schema, document, plugins),
		parse: (text, createEmptyDocument) => documentCodec.parse(text, schema, createEmptyDocument),
		serialize: document => documentCodec.serialize(document, schema),
		deserialize: value => documentCodec.deserialize(value, schema),
		validate: document => schema.validate(document),
		serializeTransaction: transaction =>
			documentCodec.serializeTransaction(
				deserializeDocumentTransaction(
					{
						format: DOCUMENT_TRANSACTION_SERIALIZATION_FORMAT,
						version: DOCUMENT_TRANSACTION_SERIALIZATION_VERSION,
						transaction,
					},
					schema,
				),
				schema,
			),
		deserializeTransaction: value => documentCodec.deserializeTransaction(value, schema),
		toPlainText: document => documentCodec.toPlainText(document, schema),
	});
}
