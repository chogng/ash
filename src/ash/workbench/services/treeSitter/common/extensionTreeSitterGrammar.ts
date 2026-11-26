export interface ExtensionTreeSitterGrammar {
	readonly languageId: string;
	readonly packageDigest: string;
	load(): Promise<ExtensionTreeSitterResources>;
}

export interface ExtensionTreeSitterResources {
	readonly wasm: Uint8Array;
	readonly highlights: string;
	readonly tags: string;
	readonly folds: string;
	readonly injections?: string;
}

export interface ExtensionTreeSitterWorkerHost {
	getGrammar(languageId: string): Promise<ExtensionTreeSitterResources | undefined>;
}

export const extensionTreeSitterWorkerChannel = 'ash.editor.extensionTreeSitter';
