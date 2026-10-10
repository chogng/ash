import type { CancellationToken, CompletionContext, CompletionItem, Disposable, ExtensionContext, Hover, JsonValue, Position, Range, TextDocument, Uri } from './index.js';
export { apiVersion, ExtensionError } from './index.js';

/** Trusted browser packages use the same author SDK lifecycle as backend JS packages. */
export interface BrowserExtensionContext extends ExtensionContext {
	readonly language: string;
}
export interface BrowserTextDocument extends Omit<TextDocument, 'uri'> { readonly uri: string; }
export interface FileMetadata { readonly isDirectory: boolean; }
/** These services borrow the initiating window's owners and expire when the callback returns. */
export interface BrowserInvocationContext {
	readonly cancellationToken: CancellationToken;
	readonly commands: { executeCommand(command: string, ...arguments_: JsonValue[]): Promise<JsonValue>; };
	readonly workspace: {
		/** Returns only roots currently accessible through the window's file services, including offline grants. */
		getWorkspaceFolders(): Promise<readonly string[]>;
		getTextDocuments(): Promise<readonly BrowserTextDocument[]>;
		/** Unsaved editor content takes precedence over disk content. */
		openTextDocument(uri: string): Promise<BrowserTextDocument>;
		getConfiguration(section: string, resource?: string | null): Promise<JsonValue>;
		stat(resource: string): Promise<FileMetadata | null>;
		readDirectory(resource: string): Promise<readonly (readonly [string, FileMetadata])[]>;
	};
}
export interface EditorReference {
	readonly resource: Uri;
	readonly groupId: string;
	readonly editorIndex: number;
}
export interface BrowserCommandContext extends BrowserInvocationContext {
	/** The command's originating editor, including actions on an inactive tab. */
	readonly activeEditor: EditorReference | undefined;
}
export interface CommandOptions {
	readonly icon?: string;
	readonly menus?: readonly { readonly menu: string; readonly when?: string; readonly group?: string; readonly alt?: string; }[];
}
export const commands: {
	registerCommand(command: string, title: string, callback: (context: BrowserCommandContext, ...arguments_: JsonValue[]) => JsonValue | undefined | Promise<JsonValue | undefined>, options?: CommandOptions): Disposable;
};

export type LanguageOperation = 'completion' | 'definition' | 'references' | 'rename' | 'documentSymbols' | 'foldingRanges' | 'documentLinks' | 'hover' | 'codeAction' | 'diagnostics' | 'selectionRanges' | 'workspaceSymbols' | 'documentHighlights';
interface DocumentRequest { readonly document: BrowserTextDocument; }
export type LanguageFeatureRequest =
	| (DocumentRequest & { readonly operation: 'completion'; readonly position: Position; readonly context: CompletionContext; })
	| (DocumentRequest & { readonly operation: 'definition' | 'hover' | 'documentHighlights'; readonly position: Position; })
	| (DocumentRequest & { readonly operation: 'references'; readonly position: Position; readonly includeDeclaration: boolean; })
	| (DocumentRequest & { readonly operation: 'rename'; readonly position: Position; } & ({ readonly kind: 'prepare'; } | { readonly kind: 'edit'; readonly newName: string; }))
	| (DocumentRequest & { readonly operation: 'documentSymbols' | 'foldingRanges' | 'documentLinks' | 'diagnostics'; })
	| (DocumentRequest & { readonly operation: 'codeAction'; readonly range: Range; readonly only: readonly string[]; })
	| (DocumentRequest & { readonly operation: 'selectionRanges'; readonly positions: readonly Position[]; })
	| { readonly operation: 'workspaceSymbols'; readonly query: string; };
export interface WorkspaceEdit {
	/** Order is transactional; expectedText protects cross-document edits against stale snapshots. */
	readonly entries: readonly (
		| { readonly kind: 'textDocument'; readonly resource: string; readonly expectedText: string; readonly edits: readonly { readonly range: Range; readonly text: string; }[]; }
		| { readonly kind: 'rename'; readonly source: string; readonly target: string; readonly existing: 'overwrite' | 'ignore' | 'error'; }
	)[];
}
export interface DocumentSymbol {
	readonly name: string;
	readonly kind: number;
	readonly range: Range;
	readonly selectionRange: Range;
	readonly children: readonly DocumentSymbol[];
}
export type LanguageFeatureResult =
	| null | Hover | WorkspaceEdit
	| { readonly isIncomplete: boolean; readonly items: readonly CompletionItem[]; }
	| { readonly range: Range; readonly placeholder: string; }
	| { readonly diagnostics: readonly { readonly range: Range; readonly severity: 'error' | 'warning' | 'information' | 'hint'; readonly message: string; readonly code?: string; }[]; }
	| readonly Range[] | readonly DocumentSymbol[]
	| readonly { readonly resource: string; readonly range: Range; readonly name?: string; readonly kind?: number; }[]
	| readonly { readonly range: Range; readonly kind: number; }[]
	| readonly { readonly startLine: number; readonly endLine: number; readonly kind?: string; }[]
	| readonly { readonly range: Range; readonly target: string; }[]
	| readonly { readonly title: string; readonly kind?: string; readonly edit?: WorkspaceEdit; readonly disabledReason?: string; }[];
export interface LanguageFeatureProvider {
	readonly operations: readonly LanguageOperation[];
	provideLanguageFeatures(context: BrowserInvocationContext, request: LanguageFeatureRequest): LanguageFeatureResult | Promise<LanguageFeatureResult>;
}
/** Positions use zero-based UTF-16 line/character coordinates, as in the shared SDK. */
export const languages: {
	registerLanguageProvider(registrationId: string, languageIds: readonly string[], provider: LanguageFeatureProvider, triggerCharacters?: readonly string[]): Disposable;
};

export interface CustomTextEditorDocument {
	readonly uri: string;
	readonly text: string;
	readonly languageId: string;
	readonly version: number;
	readonly readOnly: boolean;
}
export interface CustomTextEditorContent {
	readonly html: string;
	readonly resources?: { readonly script: string; readonly style: string; };
	readonly update?: { readonly type: 'document'; } & CustomTextEditorDocument;
}
export interface CustomTextEditorOptions {
	readonly displayName: string;
	readonly priority: 'default' | 'option';
	readonly selectors: readonly string[];
	readonly languageIds?: readonly string[];
}
export interface WebviewResource extends Disposable { readonly uri: string; }
export const window: {
	registerCustomTextEditorProvider(viewType: string, provider: {
		resolveCustomTextEditor(context: BrowserInvocationContext, document: CustomTextEditorDocument): CustomTextEditorContent | Promise<CustomTextEditorContent>;
	}, options: CustomTextEditorOptions): Disposable;
	/** Creation is activation-only. Explicit disposal and Worker retirement both release the URL. */
	createWebviewResource(content: string, mediaType: 'text/javascript' | 'text/css'): WebviewResource;
};
export function throwIfCancelled(token: CancellationToken): void;
export const noEvent: <T>(listener: (event: T) => unknown) => Disposable;
/** Bundle this adapter with the browser entry; the product supplies its versioned private host bridge. */
export function defineBrowserExtension(activate: (context: BrowserExtensionContext) => void | Promise<void>, deactivate?: () => void | Promise<void>): {
	activate(host: unknown): Promise<void>;
	deactivate(): Promise<void>;
};
