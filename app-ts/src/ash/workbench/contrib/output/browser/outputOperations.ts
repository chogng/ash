import { URI } from "../../../../base/common/uri.js";
import type { IEditorService } from "../../../services/editor/common/editorService.js";
import type { IWorkbenchHostService } from "../../../services/host/common/workbenchHostService.js";
import type { IOutputChannel } from "../../../services/output/common/outputService.js";

/** Opens a read-only point-in-time snapshot of one Output channel. */
export async function openOutputChannelInEditor(channel: IOutputChannel, editorService: IEditorService): Promise<void> {
	const name = safeOutputFileName(channel.label);
	const resource = URI.parse(`untitled:/Output-${encodeURIComponent(name)}-${Date.now()}.log`);
	await editorService.openEditor({ resource, contentType: "text/plain", ...(channel.descriptor.languageId ? { languageId: channel.descriptor.languageId } : {}), label: `${channel.label}.log`, readOnly: true, initialText: channel.getText() });
}

/** Downloads the complete retained content of one Output channel. */
export function exportOutputChannel(channel: IOutputChannel, hostService: IWorkbenchHostService): void {
	hostService.downloadText({ fileName: `${safeOutputFileName(channel.label)}.log`, content: channel.getText(), mediaType: "text/plain;charset=utf-8" });
}

export function safeOutputFileName(label: string): string {
	return label.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-").trim() || "Output";
}
