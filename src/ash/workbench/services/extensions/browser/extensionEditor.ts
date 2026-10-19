import type { EditorFeatureSet } from '../../../../editor/browser/editorExtensions.js';
import type { EditorProfile } from '../../documentEditor/browser/documentEditorProfile.js';
import type { ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';

/** Package-owned view behavior. The loader supplies only the versioned public client mechanisms. */
export interface ExtensionEditorModule {
	readonly packageId: string;
	readonly packageVersion: string;
	getEditorProfile(editorId: string): EditorProfile;
}

interface ExtensionEditorContributionModule {
	readonly packageId: string;
	readonly packageVersion: string;
	getEditorFeatures(): EditorFeatureSet;
}

export type ExtensionEditorClientModule = ExtensionEditorModule | ExtensionEditorContributionModule;

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
