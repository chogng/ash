import type { DocumentDecorationSet } from "./documentDecoration.js";
import type { DocumentNode } from "./document.js";
import type { DocumentSchema } from "./documentSchema.js";
import type { DocumentSelection } from "../core/documentSelection.js";
import type { DocumentTransaction } from "./documentTransaction.js";

/** Origins that a document plugin can observe when Stanza advances its state. */
export type DocumentPluginChangeOrigin = "user" | "remote" | "undo" | "redo" | "reset";

/** Stable identity used to retrieve one plugin's state from a TextModel structure. */
export class DocumentPluginKey<T> {
	constructor(readonly name: string) {
		if (typeof name !== "string" || name.trim().length === 0) throw new TypeError("Document plugin keys require a non-empty name");
		Object.freeze(this);
	}
}

export interface DocumentPluginInitContext {
	readonly schema: DocumentSchema;
	readonly document: DocumentNode;
	readonly selection: DocumentSelection | undefined;
	readonly version: number;
}

export interface DocumentPluginApplyContext {
	readonly schema: DocumentSchema;
	readonly previousDocument: DocumentNode;
	readonly document: DocumentNode;
	readonly previousSelection: DocumentSelection | undefined;
	readonly selection: DocumentSelection | undefined;
	readonly transaction: DocumentTransaction;
	readonly origin: DocumentPluginChangeOrigin;
	readonly previousVersion: number;
	readonly version: number;
}

export interface DocumentPluginTransactionContext {
	readonly schema: DocumentSchema;
	readonly document: DocumentNode;
	readonly selection: DocumentSelection | undefined;
	readonly origin: DocumentPluginChangeOrigin;
	readonly version: number;
}

export interface DocumentPluginSelectionContext {
	readonly schema: DocumentSchema;
	readonly document: DocumentNode;
	readonly previousSelection: DocumentSelection | undefined;
	readonly selection: DocumentSelection | undefined;
	readonly version: number;
}

export interface DocumentPluginDecorationContext<T> {
	readonly schema: DocumentSchema;
	readonly document: DocumentNode;
	readonly selection: DocumentSelection | undefined;
	readonly version: number;
	readonly state: T;
}

export interface DocumentPluginState<T> {
	init(context: DocumentPluginInitContext): T;
	apply(value: T, context: DocumentPluginApplyContext): T;
	applySelection?(value: T, context: DocumentPluginSelectionContext): T;
}

/** A common-state extension that is updated atomically with Stanza document changes. */
export interface DocumentPlugin<T> {
	readonly key: DocumentPluginKey<T>;
	readonly state: DocumentPluginState<T>;
	filterTransaction?(transaction: DocumentTransaction, context: DocumentPluginTransactionContext): boolean;
	decorations?(state: T, context: DocumentPluginDecorationContext<T>): DocumentDecorationSet | undefined;
}

export interface DocumentPluginOptions<T = unknown> {
	readonly filterTransaction?: (transaction: DocumentTransaction, context: DocumentPluginTransactionContext) => boolean;
	readonly decorations?: (state: T, context: DocumentPluginDecorationContext<T>) => DocumentDecorationSet | undefined;
}

/** Creates a validated immutable plugin descriptor for a structured Stanza TextModel. */
export function createDocumentPlugin<T>(key: DocumentPluginKey<T>, state: DocumentPluginState<T>, options: DocumentPluginOptions<T> = {}): DocumentPlugin<T> {
	if (!key || typeof key.name !== "string") throw new TypeError("Document plugins require a plugin key");
	if (!state || typeof state.init !== "function" || typeof state.apply !== "function") throw new TypeError(`Document plugin '${key.name}' requires init and apply state functions`);
	if (options.filterTransaction !== undefined && typeof options.filterTransaction !== "function") throw new TypeError(`Document plugin '${key.name}' filterTransaction must be a function`);
	if (options.decorations !== undefined && typeof options.decorations !== "function") throw new TypeError(`Document plugin '${key.name}' decorations must be a function`);
	return Object.freeze({ key, state, ...(options.filterTransaction ? { filterTransaction: options.filterTransaction } : {}), ...(options.decorations ? { decorations: options.decorations } : {}) });
}
