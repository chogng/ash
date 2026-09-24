import { VSBuffer } from "../../../../base/common/buffer.js";
import { type LanguageWorkspaceSymbol } from '../../../../editor/common/languages.js';
import { type IFileService } from "../../../../platform/files/common/files.js";
import { type IEditorService } from "../../../services/editor/common/editorService.js";
import { type IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";

/** Opens a Workspace Symbol only after a local index result still matches current file content. */
export async function acceptWorkspaceSymbol(symbol: LanguageWorkspaceSymbol, files: IFileService, workingCopies: IWorkingCopyService, editor: IEditorService, quickPick: { hide(): void }, refresh: () => void): Promise<void> {
	const revision = localSymbolRevision(symbol);
	if (revision) {
		try {
			if (await currentSourceRevision(symbol, files, workingCopies) !== revision) {
				refresh();
				return;
			}
		} catch (error) {
			console.error("Could not verify workspace symbol", error);
			refresh();
			return;
		}
	}
	quickPick.hide();
	await editor.openEditor({ resource: symbol.resource }, { selection: symbol.range }).catch(error => console.error("Could not open workspace symbol", error));
}

async function currentSourceRevision(symbol: LanguageWorkspaceSymbol, files: IFileService, workingCopies: IWorkingCopyService): Promise<string | undefined> {
	const contents = workingCopies.get(symbol.resource).filter(workingCopy => workingCopy.backupKind === "text").map(workingCopy => workingCopy.backup());
	if (contents.length > 0) {
		const content = contents[0] as string;
		if (contents.some(candidate => candidate !== content)) return undefined;
		const digest = await globalThis.crypto.subtle.digest("SHA-256", VSBuffer.fromString(content).buffer);
		return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
	}
	const current = await files.readFile(symbol.resource);
	return `sha256:${current.revision}`;
}

function localSymbolRevision(symbol: LanguageWorkspaceSymbol): string | undefined {
	if (!symbol.data || typeof symbol.data !== "object") return undefined;
	const data = symbol.data as { source?: unknown; sourceRevision?: unknown };
	return data.source === "codebaseSymbols" && typeof data.sourceRevision === "string" && data.sourceRevision.startsWith("sha256:") ? data.sourceRevision : undefined;
}
