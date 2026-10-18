import { TreeVisibility, type TreeFilter, type TreeFilterResult } from '../../../../base/browser/ui/tree/tree.js';
import { matchesSubString } from '../../../../base/common/filters.js';
import type { DebugConsoleEntry } from '../../../../platform/debug/common/debugAdapterProcessService.js';

/** Filters the Rust-owned output snapshot without retaining or changing its entries. */
export class ReplFilter implements TreeFilter<DebugConsoleEntry> {
	static matchQuery = matchesSubString;
	private includes: string[] = [];
	private excludes: string[] = [];

	set filterQuery(query: string) {
		this.includes = [];
		this.excludes = [];
		for (const term of query.split(',')) {
			const text = term.trim();
			if (!text) continue;
			if (text.startsWith('!')) {
				const excluded = text.slice(1).trim();
				if (excluded) this.excludes.push(excluded);
			} else this.includes.push(text);
		}
	}

	filter(element: DebugConsoleEntry, parentVisibility: TreeVisibility): TreeFilterResult {
		// An expression and its result remain together even when output is filtered.
		if (element.kind === 'input' || element.kind === 'evaluation') return TreeVisibility.Visible;
		const matches = (query: string) => ReplFilter.matchQuery(query, element.output) !== null;
		if (this.excludes.some(matches)) return TreeVisibility.Hidden;
		if (this.includes.length === 0) return parentVisibility;
		if (this.includes.some(matches)) return TreeVisibility.Visible;
		// A group's text may not match while a nested output does. The caller
		// resolves Recurse against the immutable snapshot's parent IDs.
		return element.kind === 'group' ? TreeVisibility.Recurse : TreeVisibility.Hidden;
	}
}
