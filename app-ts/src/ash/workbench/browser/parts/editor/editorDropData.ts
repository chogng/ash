import { containsDragType, DataTransfers } from "../../../../base/browser/dnd.js";
import { Mimes } from "../../../../base/common/mime.js";
import { URI } from "../../../../base/common/uri.js";
import { createUuid } from "../../../../base/common/uuid.js";
import { getPathForFile } from "../../../../platform/dnd/browser/dnd.js";
import type { EditorInput } from "./editorInput.js";

/** Returns whether a native drag exposes resources the editor can open. */
export function containsExternalEditorDrop(event: DragEvent): boolean {
	return containsDragType(event, Mimes.uriList) || containsDragType(event, DataTransfers.FILES);
}

/** Converts native URI and file transfers into frontend-owned editor inputs. */
export async function extractExternalEditorInputs(dataTransfer: DataTransfer): Promise<readonly EditorInput[]> {
	const uriList = dataTransfer.getData(Mimes.uriList);
	const files = [...dataTransfer.files];
	const inputs: EditorInput[] = [];
	const resources = new Set<string>();
	for (const value of uriList.split(/\r?\n/)) {
		const candidate = value.trim();
		if (!candidate || candidate.startsWith("#")) continue;
		const resource = URI.parse(candidate);
		if (resources.has(resource.toString())) continue;
		resources.add(resource.toString());
		inputs.push({ resource });
	}
	for (const file of files) {
		const nativePath = getPathForFile(file);
		const resource = typeof nativePath === "string" && nativePath.length > 0
			? URI.file(nativePath)
			: URI.parse(`untitled:/dropped/${createUuid()}/${encodeURIComponent(file.name || "Dropped file")}`);
		if (resources.has(resource.toString())) continue;
		resources.add(resource.toString());
		inputs.push({
			resource,
			label: file.name || undefined,
			contentType: file.type || undefined,
			...(resource.scheme === "untitled" ? { initialText: await file.text() } : {}),
		});
	}
	return inputs;
}
