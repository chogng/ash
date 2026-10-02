import type { URI } from "../../../../base/common/uri.js";
import { FileKind } from "../../../../platform/files/common/files.js";
import type { Position } from "../../../../editor/common/core/position.js";
import type { LanguageDocumentSymbol } from "../../../../editor/common/languages.js";
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

/** One location in the resource path shown by the editor breadcrumbs. */
export class FileElement {
	constructor(
		readonly uri: URI,
		readonly kind: FileKind,
		readonly label: string,
	) {}
}

export class SymbolElement {
	constructor(readonly symbol: LanguageDocumentSymbol) {}
	get label(): string { return this.symbol.name; }
}

/** Builds the resource path displayed for one editor input. */
export class BreadcrumbsModel {
	constructor(readonly resource: URI, private readonly workspaceFolder: IWorkspaceFolder | null, private readonly fallbackLabel?: string) {}

	getElements(): readonly FileElement[] {
		const segments = this.resource.toEncodedComponents().path.split("/").filter(Boolean);
		const elements: FileElement[] = [];
		const rootDepth = this.workspaceFolder?.uri.toEncodedComponents().path.split('/').filter(Boolean).length ?? 0;
		if (this.workspaceFolder && rootDepth === 0) {
			elements.push(new FileElement(this.workspaceFolder.uri, FileKind.Directory, this.workspaceFolder.name));
		}
		if (this.resource.authority && !this.workspaceFolder) {
			elements.push(new FileElement(
				this.resource.with({ path: '/' }),
				FileKind.Directory,
				this.resource.authority,
			));
		}
		let currentPath = "";
		for (const [index, segment] of segments.entries()) {
			currentPath += `/${segment}`;
			// Trim display ancestors only; picker navigation still needs the complete URI.
			if (index < rootDepth - 1) {
				continue;
			}
			const isWorkspaceRoot = this.workspaceFolder !== null && index === rootDepth - 1;
			elements.push(new FileElement(
				this.resource.withEncodedPath(currentPath),
				index === segments.length - 1 && !isWorkspaceRoot ? FileKind.File : FileKind.Directory,
				isWorkspaceRoot ? this.workspaceFolder!.name : decodeURIComponent(segment),
			));
		}
		if (elements.length === 0) {
			elements.push(new FileElement(
				this.resource,
				FileKind.File,
				this.fallbackLabel?.trim() || this.resource.toString(),
			));
		}
		return elements;
	}

	/** Returns the nesting chain that contains the current cursor. */
	static symbolPath(symbols: readonly LanguageDocumentSymbol[], position: Position): readonly SymbolElement[] {
		const path: SymbolElement[] = [];
		let siblings = symbols;
		while (true) {
			const containing = siblings.find(symbol => symbol.range.containsPosition(position));
			if (!containing) return path;
			path.push(new SymbolElement(containing));
			siblings = containing.children ?? [];
		}
	}
}
