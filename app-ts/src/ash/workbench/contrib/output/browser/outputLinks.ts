import { URI } from "../../../../base/common/uri.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import { workspaceRelativePath } from "../../../../platform/files/browser/fileService.js";
import type { IWorkspaceFolder } from "../../../../platform/workspace/common/workspace.js";

export interface OutputLink {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly label: string;
	readonly resource: URI;
	readonly selection: Range;
}

const LocationPattern = /((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])?[^\s:(),]+(?:[\\/][^\s:(),]+)*\.[A-Za-z0-9_-]+)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))/g;

/** Detects file locations and returns only resources authorized by the current workspace. */
export function detectOutputLinks(text: string, folders: readonly IWorkspaceFolder[]): readonly OutputLink[] {
	const links: OutputLink[] = [];
	for (const match of text.matchAll(LocationPattern)) {
		const label = match[0];
		const candidate = match[1];
		const startIndex = match.index;
		if (!label || !candidate || startIndex === undefined) continue;
		const resource = resolveWorkspaceResource(candidate, folders);
		if (!resource) continue;
		const line = parseCoordinate(match[2] ?? match[4]);
		const column = parseCoordinate(match[3] ?? match[5]);
		links.push(Object.freeze({ startIndex, endIndex: startIndex + label.length, label, resource, selection: Range.fromPositions(new Position((line) + 1, (column) + 1)) }));
	}
	return Object.freeze(links);
}

function resolveWorkspaceResource(candidate: string, folders: readonly IWorkspaceFolder[]): URI | undefined {
	const normalized = candidate.replaceAll("\\", "/");
	const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
	if (absolute) {
		let resource: URI;
		try { resource = URI.file(candidate); }
		catch { return undefined; }
		return folders.some(folder => belongsToWorkspace(folder.uri, resource)) ? resource : undefined;
	}
	const segments = normalized.split("/");
	if (segments.some(segment => !segment || segment === "." || segment === "..")) return undefined;
	for (const folder of folders) {
		const path = `${folder.uri.path.replace(/\/$/, "")}/${segments.map(encodeURIComponent).join("/")}`;
		const resource = folder.uri.withPath(path);
		if (belongsToWorkspace(folder.uri, resource)) return resource;
	}
	return undefined;
}

function belongsToWorkspace(root: URI, resource: URI): boolean {
	try { workspaceRelativePath(root, resource); return true; }
	catch { return false; }
}

function parseCoordinate(value: string | undefined): number {
	if (!value) return 0;
	const coordinate = Number.parseInt(value, 10);
	return Number.isSafeInteger(coordinate) && coordinate > 0 ? coordinate - 1 : 0;
}
