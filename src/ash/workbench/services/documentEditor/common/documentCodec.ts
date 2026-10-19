import type { DocumentNode } from '../../../../../../extensions/academic/common/model/document.js';
import type { DocumentSchema } from '../../../../../../extensions/academic/common/model/documentSchema.js';
import type { DocumentTextModel } from '../../../../../../extensions/academic/common/model/documentTextModel.js';
import type { DocumentPlugin } from '../../../../../../extensions/academic/common/model/documentPlugin.js';
import type { DocumentTransaction } from '../../../../../../extensions/academic/common/model/documentTransaction.js';

/** Semantics supplied by one admitted editor package; the host owns resource and dirty state. */
export interface DocumentCodec {
	createModel(schema: DocumentSchema, document: DocumentNode, plugins?: readonly DocumentPlugin<unknown>[]): DocumentTextModel;
	parse(text: string, schema: DocumentSchema, createEmptyDocument?: () => DocumentNode): DocumentNode;
	serialize(document: DocumentNode, schema: DocumentSchema): string;
	deserialize(value: unknown, schema: DocumentSchema): DocumentNode;
	serializeTransaction(transaction: DocumentTransaction, schema: DocumentSchema): string;
	deserializeTransaction(value: unknown, schema: DocumentSchema): DocumentTransaction;
	toPlainText(document: DocumentNode, schema: DocumentSchema): string;
}

export type DocumentTextFormat = 'text' | 'markdown';
