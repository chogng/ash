import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Reads and writes user-facing text through the current host clipboard. */
export interface IClipboardService {
	readText(): Promise<string>;
	writeText(value: string): Promise<void>;
}

export const IClipboardService = createServiceIdentifier<IClipboardService>("clipboardService");
