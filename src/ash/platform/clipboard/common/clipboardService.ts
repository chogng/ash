import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { URI } from '../../../base/common/uri.js';

/** Reads and writes text and file resources through the current host clipboard. */
export interface IClipboardResources {
	readonly resources: readonly URI[];
	readonly operation: 'copy' | 'move';
}

export interface IClipboardService {
	readText(): Promise<string>;
	writeText(value: string): Promise<void>;
	readResources(): Promise<IClipboardResources>;
	writeResources(resources: readonly URI[], operation: 'copy' | 'move'): Promise<void>;
	hasResources(): Promise<boolean>;
}

export const IClipboardService = createServiceIdentifier<IClipboardService>("clipboardService");
