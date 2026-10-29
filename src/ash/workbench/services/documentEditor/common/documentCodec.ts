import type { Event } from '../../../../base/common/event.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';

export type DocumentNodeId = string;
export type DocumentAttributeValue = string | number | boolean | null;
export type DocumentAttributes = Readonly<Record<string, DocumentAttributeValue>>;
export interface DocumentMark {
	readonly type: string;
	readonly attrs: DocumentAttributes;
}

/** Immutable document data shared by persistence, conversion and package-owned views. */
export interface DocumentNode {
	readonly id: DocumentNodeId;
	readonly type: string;
	readonly attrs: DocumentAttributes;
	readonly content: readonly DocumentNode[];
	readonly marks: readonly DocumentMark[];
	readonly text?: string;
}

export interface DocumentPoint {
	readonly nodeId: string;
	readonly offset: number;
}
export interface DocumentTextSelection {
	readonly kind: 'text';
	readonly anchor: DocumentPoint;
	readonly head: DocumentPoint;
}
export interface NodeSelection {
	readonly kind: 'node';
	readonly nodeId: string;
}
export interface AllSelection {
	readonly kind: 'all';
}
export type DocumentSelection = DocumentTextSelection | NodeSelection | AllSelection;

export interface DocumentOutlineEntry {
	readonly nodeId: string;
	readonly parentHeadingId: string | undefined;
	readonly depth: number;
	readonly level: number;
	readonly title: string;
}
export type DocumentOutline = readonly DocumentOutlineEntry[];

/** The host observes persistence changes; semantic transactions and schema stay in the package. */
export interface DocumentTextModel extends TextModel {
	readonly documentType: string;
	readonly document: DocumentNode;
	readonly onDidChangeBlocks: Event<unknown>;
	resetBlocks(document: DocumentNode): void;
}

/** Bound to one package schema and plugin configuration before the host acquires a model. */
export interface DocumentCodec {
	readonly documentType: string;
	createModel(document: DocumentNode): DocumentTextModel;
	parse(text: string, createEmptyDocument?: () => DocumentNode): DocumentNode;
	serialize(document: DocumentNode): string;
	deserialize(value: unknown): DocumentNode;
	validate(document: DocumentNode): void;
	serializeTransaction(transaction: unknown): string;
	deserializeTransaction(value: unknown): unknown;
	toPlainText(document: DocumentNode): string;
}

export type DocumentTextFormat = 'text' | 'markdown';
