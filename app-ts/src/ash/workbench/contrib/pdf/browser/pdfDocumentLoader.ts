import { raceCancellationError } from "../../../../base/common/async.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import type { EditorInput } from "../../../browser/parts/editor/editorInput.js";

/** Loads the immutable bytes that Chromium's PDF Viewer renders for one editor input. */
export interface IPdfDocumentLoader {
	load(input: EditorInput, signal: AbortSignal): Promise<Uint8Array>;
}

/** Reads PDF bytes through the workspace-confined file service. */
export class WorkspacePdfDocumentLoader implements IPdfDocumentLoader {
	constructor(private readonly fileService: IFileService) {}

	async load(input: EditorInput, signal: AbortSignal): Promise<Uint8Array> {
		const content = await raceCancellationError(
			this.fileService.readFileBytes(input.resource),
			signal,
			"PDF document loading was cancelled",
		);
		return content.bytes;
	}
}
