import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { URI } from '../../../base/common/uri.js';

export interface IClipboardResources {
	readonly resources: readonly URI[];
	readonly operation: 'copy' | 'move';
}

/** Reads images and reads or writes text and file resources through the current host clipboard. */
export interface IClipboardService {
	readText(): Promise<string>;
	/** Returns PNG bytes, or an empty buffer when the clipboard contains no image. */
	readImage(): Promise<Uint8Array>;
	writeText(value: string): Promise<void>;
	readResources(): Promise<IClipboardResources>;
	writeResources(resources: readonly URI[], operation: 'copy' | 'move'): Promise<void>;
	hasResources(): Promise<boolean>;
}

export const IClipboardService = createServiceIdentifier<IClipboardService>("clipboardService");
