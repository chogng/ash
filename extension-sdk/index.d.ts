/** Public author API. The host binds identity and permissions; callers never supply an extension ID. */
export const apiVersion: 1;
/** Rust service failures retain a stable protocol code; extension callback errors stay ordinary Error objects. */
export class ExtensionError extends Error {
	readonly code: string;
	constructor(code: string, message: string);
}
export interface Disposable { dispose(): void; }
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface TextDocument {
	readonly uri: string | undefined;
	readonly version: number;
	readonly languageId: string;
	readonly text: string;
	getText(): string;
}
/** Zero-based UTF-16 coordinates, including for documents containing surrogate pairs. */
export interface Position { readonly line: number; readonly character: number; }
export interface Range { readonly start: Position; readonly end: Position; }
export interface Hover {
	readonly contents: readonly (string | { readonly value: string; readonly language?: string })[];
	readonly range?: Range;
}
export interface HoverProvider {
	provideHover(context: InvocationContext, document: TextDocument, position: Position): Hover | undefined | Promise<Hover | undefined>;
}
export interface CompletionItem {
	readonly id: string;
	readonly label: string;
	readonly kind: 'text' | 'method' | 'function' | 'constructor' | 'field' | 'variable' | 'class' | 'interface' | 'module' | 'property' | 'unit' | 'value' | 'enum' | 'keyword' | 'snippet' | 'file' | 'reference' | 'folder' | 'typeParameter';
	readonly range: Range;
	readonly insertText: string;
	readonly insertTextFormat: 'plainText' | 'snippet';
	readonly detail?: string;
	readonly documentation?: string;
	readonly filterText?: string;
	readonly sortText?: string;
	readonly preselect?: boolean;
	readonly commitCharacters?: readonly string[];
	readonly additionalTextEdits?: readonly { readonly range: Range; readonly text: string; }[];
}
export type CompletionContext = { readonly kind: 'invoke' | 'incompleteRefresh'; } | { readonly kind: 'triggerCharacter'; readonly triggerCharacter: string; };
export interface CompletionProvider {
	provideCompletionItems(context: InvocationContext, document: TextDocument, position: Position, trigger: CompletionContext): { readonly isIncomplete: boolean; readonly items: readonly CompletionItem[]; } | Promise<{ readonly isIncomplete: boolean; readonly items: readonly CompletionItem[]; }>;
}
export interface Diagnostic {
	readonly start: Position;
	readonly end: Position;
	readonly message: string;
	readonly severity: 'error' | 'warning' | 'information' | 'hint';
	readonly source: string | null;
	readonly code: string | null;
}
export interface DiagnosticEntry {
	readonly uri: string;
	/** Null is reserved for resources not read in this invocation. */
	readonly version: number | null;
	readonly diagnostics: readonly Diagnostic[];
}
export type TextDocumentEvent =
	| { readonly type: 'open' | 'close'; readonly document: Omit<TextDocument, 'getText' | 'uri'> & { readonly uri: string; }; }
	| { readonly type: 'change'; readonly document: Omit<TextDocument, 'getText' | 'uri'> & { readonly uri: string; }; readonly reason: string; readonly contentChanges: readonly { readonly range: Range; readonly rangeOffset: number; readonly rangeLength: number; readonly text: string; }[]; };
/** Operations are scoped to this invocation and stop when its parent is cancelled or retired. */
export interface InvocationContext {
	readonly languages: {
		/** Replaces this incarnation's entire named collection; an empty array clears it. */
		setDiagnostics(collection: string, entries: readonly DiagnosticEntry[]): Promise<void>;
	};
	readonly workspace: {
		/** Reads the editor's current text, including unsaved changes. */
		openTextDocument(uri: string): Promise<TextDocument>;
		/** Reads UTF-8 disk content beneath the invocation's granted workspace; maximum 256 KiB. */
		readTextFile(path: string): Promise<string>;
	};
	readonly window: {
		showInformationMessage(message: string): Promise<void>;
		showWarningMessage(message: string): Promise<void>;
		showErrorMessage(message: string): Promise<void>;
		showQuickPick(items: readonly string[], placeholder: string): Promise<string | undefined>;
	};
}
export interface ExtensionContext {
	readonly extensionId: string;
	readonly subscriptions: Disposable[];
}
/** Registration occurs during activate; dispose revokes its callback. The host publishes the activation atomically. */
export const commands: {
	registerCommand(command: string, title: string, callback: (context: InvocationContext, ...arguments_: JsonValue[]) => JsonValue | undefined | Promise<JsonValue | undefined>): Disposable;
};
/** Uses the initiating editor's immutable snapshot. Cancellation retires the host, including pending provider callbacks. */
export const languages: {
	registerHoverProvider(registrationId: string, languageIds: readonly string[], provider: HoverProvider): Disposable;
	registerCompletionProvider(registrationId: string, languageIds: readonly string[], provider: CompletionProvider, triggerCharacters?: readonly string[]): Disposable;
};
export const workspace: {
	/** Ordered callbacks, beginning with open events for existing models after activation. */
	registerTextDocumentEvents(registrationId: string, listener: (context: InvocationContext, event: TextDocumentEvent) => void | Promise<void>): Disposable;
};
/** Export activate from the ESM entry. Import the SDK as '@ash/extension'; no Node module loader is supplied. */
export type Activate = (context: ExtensionContext) => void | Promise<void>;
export type Deactivate = () => void | Promise<void>;
