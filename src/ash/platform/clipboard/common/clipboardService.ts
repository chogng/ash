import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { URI } from '../../../base/common/uri.js';

export interface IClipboardResources {
	readonly resources: readonly URI[];
	readonly operation: 'copy' | 'move';
}

/** A clipboard representation captured as bytes, without host objects or deferred reads. */
export interface IClipboardItem {
	readonly type: string;
	readonly data: Uint8Array;
}

/** Reads images and reads or writes text and file resources through the current host clipboard. */
export interface IClipboardService {
	/** Returns undefined when this host cannot trigger a paste in the registered target window. */
	triggerPaste(targetWindowId: number): Promise<void> | undefined;
	/** Reads available MIME representations; hosts without rich reads return plain text. Access failures reject. */
	read(): Promise<readonly IClipboardItem[]>;
	readText(type?: string): Promise<string>;
	/** Returns PNG bytes, or an empty buffer when the clipboard contains no image. */
	readImage(): Promise<Uint8Array>;
	writeText(value: string, type?: string): Promise<void>;
	/** Reads the shared find term independently of copied text. */
	readFindText(): Promise<string>;
	writeFindText(text: string): Promise<void>;
	readResources(): Promise<IClipboardResources>;
	writeResources(resources: readonly URI[], operation: 'copy' | 'move'): Promise<void>;
	hasResources(): Promise<boolean>;
}

export const IClipboardService = createServiceIdentifier<IClipboardService>("clipboardService");
