import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface WorkbenchTextDownload {
	readonly fileName: string;
	readonly content: string;
	readonly mediaType: string;
}

/** Window-host operations available without exposing the Workbench DOM root. */
export interface IWorkbenchHostService {
	downloadText(download: WorkbenchTextDownload): void;
}

export const IWorkbenchHostService = createServiceIdentifier<IWorkbenchHostService>("workbenchHostService");
