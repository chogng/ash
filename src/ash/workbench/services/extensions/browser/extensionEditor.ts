import type { EditorFeatureSet } from '../../../../editor/browser/editorExtensions.js';
import type { EditorProfile } from '../../documentEditor/browser/documentEditorProfile.js';

/** Product-compiled view behavior. No service container, backend connection or document is passed to a module. */
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

export type ExtensionEditorModuleLoader = (packageName: string, entry: string, expectedDigest: string) => Promise<ExtensionEditorClientModule>;
