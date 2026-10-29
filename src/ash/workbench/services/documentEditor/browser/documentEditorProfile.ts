import type { IEditorExtensionApi } from '../../../common/editor.js';
import type { DocumentCodec, DocumentNode, DocumentTextFormat, DocumentTextModel, DocumentSelection, DocumentOutline } from '../common/documentCodec.js';
import type { Constructor } from '../../../../platform/instantiation/common/descriptors.js';
import type { URI } from '../../../../base/common/uri.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { DocumentCollaborationConnection } from '../../documentCollaboration/common/documentCollaborationService.js';

export interface DocumentEditorWidget extends IDisposable {
	readonly isDisposed: boolean;
	create(parent: HTMLElement): void;
	setModel(model: DocumentTextModel, input: { readonly resource: URI; readonly readOnly?: boolean; }): void;
	setReadOnly(readOnly: boolean): void;
	clearInput(): void;
	layout(dimension: IDimension): void;
	focus(): void;
	exportArtifact?(format: string, signal: AbortSignal): Promise<Uint8Array>;
	getAccessibleContent?(): string;
	getExtensionApi?(id: string): IEditorExtensionApi | undefined;
	getDocument(): DocumentNode;
	getDocumentSelection(): DocumentSelection | undefined;
	getOutline(): DocumentOutline;
	clearCollaboration(): void;
	setCollaborationConnection(connection: DocumentCollaborationConnection): {
		readonly onDidChangeState: Event<{ readonly state: 'connected' | 'resyncRequired' | 'error'; readonly message?: string; }>;
		readonly onDidConfirmDocument: Event<DocumentNode>;
		invalidate(message: string): void;
	};
}

/** Package-private schema, plugins and UI options are already captured by these closures. */
export interface DocumentEditorConfiguration {
	/** The package describes its own controls; the host adds only Workbench actions. */
	readonly accessibilityHelp?: () => readonly string[];
	readonly artifactFormats?: readonly { readonly id: string; readonly label: string; readonly extension: string; readonly mimeType: string; readonly canImport: boolean; }[];
	importBinary?(bytes: Uint8Array, format: string, ownerDocument: Document, signal: AbortSignal): Promise<{ readonly document: DocumentNode; readonly documentType: string; }>;
	readonly codec: DocumentCodec;
	readonly widget: Constructor<DocumentEditorWidget>;
	readonly createEmptyDocument?: () => DocumentNode;
	/** The host supplies resource IO without interpreting the package's document structure. */
	importText(text: string, format: DocumentTextFormat, ownerDocument: Document, source: URI, readResource: (resource: URI) => Promise<Uint8Array>): DocumentNode | Promise<DocumentNode>;
	exportText(document: DocumentNode, format: DocumentTextFormat): string;
}

export interface EditorProfile {
	readonly editorId?: string;
	readonly id: string;
	readonly contentType: string;
	readonly collaborationSchemaId?: string;
	create(): DocumentEditorConfiguration;
}
