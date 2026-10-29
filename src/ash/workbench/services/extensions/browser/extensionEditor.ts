import type { EditorProfile } from '../../documentEditor/browser/documentEditorProfile.js';
import type { ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import type { IEditorPane } from '../../../common/editor.js';
/** A lifetime-bound constructor callback; it exposes no lookup, registration or service container. */
export type EditorClientInstantiation = <T>(constructor: new (...args: any[]) => T, ...args: any[]) => T;
export type ResourceEditorConstructor = new (...args: any[]) => IEditorPane & { create(parent: HTMLElement): void; };

/** Package-owned view behavior. The loader supplies only the versioned public client mechanisms. */
export interface ExtensionEditorModule {
	readonly packageId: string;
	readonly packageVersion: string;
	getEditorProfile(editorId: string): EditorProfile;
}

/** A package-owned binary/resource view; its lifetime is bound to the admitted provider. */
export interface ExtensionResourceEditorModule {
	readonly packageId: string;
	readonly packageVersion: string;
	getResourceEditor(editorId: string, createInstance: EditorClientInstantiation): ResourceEditorConstructor;
}

export type ExtensionEditorClientModule = ExtensionEditorModule | ExtensionResourceEditorModule;

export interface ExtensionEditorModuleRequest {
	readonly package: ExtensionDescriptor;
	readonly generation: number;
	readonly entry: string;
	readonly expectedDigest: string;
	readonly resources: IExtensionResourceLoaderService;
	readonly signal: AbortSignal;
	/** Rechecks the owning catalog admission immediately before any package code executes. */
	readonly assertCurrent: () => Promise<void>;
}

export type ExtensionEditorModuleLoader = (request: ExtensionEditorModuleRequest) => Promise<ExtensionEditorClientModule>;
