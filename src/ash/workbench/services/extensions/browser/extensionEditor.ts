import type { EditorProfile } from '../../documentEditor/browser/documentEditorProfile.js';

/** Product-compiled view behavior. No service container, backend connection or document is passed to a module. */
export interface ExtensionEditorModule {
	readonly packageId: string;
	readonly packageVersion: string;
	getEditorProfile(editorId: string): EditorProfile;
}

export type ExtensionEditorModuleLoader = (packageName: string, entry: string, expectedDigest: string) => Promise<ExtensionEditorModule>;
