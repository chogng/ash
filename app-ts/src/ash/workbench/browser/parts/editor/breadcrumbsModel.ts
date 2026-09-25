import type { URI } from "../../../../base/common/uri.js";
import { FileKind } from "../../../../platform/files/common/files.js";
import type { Position } from "../../../../editor/common/core/position.js";
import type { LanguageDocumentSymbol } from "../../../../editor/common/languages.js";

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
	constructor(readonly resource: URI, private readonly fallbackLabel?: string) {}

	getElements(): readonly FileElement[] {
		const path = decodePath(this.resource.path);
		const segments = path.split("/").filter(Boolean);
		const elements: FileElement[] = [];
		if (this.resource.authority) {
			elements.push(new FileElement(
				this.resource.withPath("/"),
				FileKind.Directory,
				this.resource.authority,
			));
		}
		let currentPath = "";
		for (const [index, segment] of segments.entries()) {
			currentPath += `/${segment}`;
			elements.push(new FileElement(
				this.resource.withPath(currentPath),
				index === segments.length - 1 ? FileKind.File : FileKind.Directory,
				segment,
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

function decodePath(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}
