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
/** Operations are scoped to this invocation and stop when its parent is cancelled or retired. */
export interface InvocationContext {
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
};
/** Export activate from the ESM entry. Import the SDK as '@ash/extension'; no Node module loader is supplied. */
export type Activate = (context: ExtensionContext) => void | Promise<void>;
export type Deactivate = () => void | Promise<void>;
