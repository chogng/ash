import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { URI } from '../../../base/common/uri.js';

/** Reads and writes text and file resources through the current host clipboard. */
export interface IClipboardService {
	readText(): Promise<string>;
	writeText(value: string): Promise<void>;
	readResources(): Promise<readonly URI[]>;
	writeResources(resources: readonly URI[]): Promise<void>;
	hasResources(): Promise<boolean>;
}

export const IClipboardService = createServiceIdentifier<IClipboardService>("clipboardService");
