import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { normalizeTextMateGrammarCatalog, type TextMateGrammarCatalog } from "./textMateGrammarCatalog.js";
import { TextMateGrammarRegistry, type TextMateGrammarRegistrySnapshot } from "./textMateGrammarRegistry.js";
import { type TextMateGrammarSnapshotSource } from "./textMateTokenizationService.js";

interface GrammarCatalogRuntime extends Disposable {
	readonly registry: TextMateGrammarRegistry;
}

/** Worker-side atomic materialization of transferable grammar catalogs. */
export class TextMateGrammarCatalogStore implements TextMateGrammarSnapshotSource, Disposable {
	private runtime: GrammarCatalogRuntime = createRuntime(EMPTY_CATALOG);
	private revision = 0;
	private disposed = false;

	get currentSnapshot(): TextMateGrammarRegistrySnapshot {
		this.ensureAlive();
		return this.runtime.registry.currentSnapshot;
	}

	get catalogRevision(): number {
		this.ensureAlive();
		return this.revision;
	}

	replace(catalog: TextMateGrammarCatalog): void {
		this.ensureAlive();
		const normalized = normalizeTextMateGrammarCatalog(catalog);
		if (normalized.revision <= this.revision) {
			throw new RangeError("TextMate Worker grammar catalog revision must increase");
		}
		const candidate = createRuntime(normalized);
		const previous = this.runtime;
		this.runtime = candidate;
		this.revision = normalized.revision;
		previous[Symbol.dispose]();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.runtime[Symbol.dispose]();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	private ensureAlive(): void {
		if (this.disposed) throw new ReferenceError("TextMateGrammarCatalogStore is already disposed");
	}
}

function createRuntime(catalog: TextMateGrammarCatalog): GrammarCatalogRuntime {
	const resources = new DisposableStore();
	const registry = resources.add(new TextMateGrammarRegistry());
	try {
		for (const grammar of catalog.grammars) {
			resources.add(registry.register({
				scopeName: grammar.scopeName,
				...(grammar.languageId === undefined ? {} : { languageId: grammar.languageId }),
				injectTo: grammar.injectTo,
				...(grammar.embeddedLanguages === undefined ? {} : { embeddedLanguages: grammar.embeddedLanguages }),
				...(grammar.tokenTypes === undefined ? {} : { tokenTypes: grammar.tokenTypes }),
				...(grammar.balancedBracketScopes === undefined ? {} : { balancedBracketScopes: grammar.balancedBracketScopes }),
				...(grammar.unbalancedBracketScopes === undefined ? {} : { unbalancedBracketScopes: grammar.unbalancedBracketScopes }),
				filePath: grammar.filePath,
				loadGrammar: () => grammar.content,
			}));
		}
	} catch (error) {
		resources.dispose();
		throw error;
	}
	return Object.freeze({
		registry,
		dispose: () => resources.dispose(),
		[Symbol.dispose]: () => resources.dispose(),
	});
}

const EMPTY_CATALOG: TextMateGrammarCatalog = Object.freeze({
	revision: 0,
	grammars: Object.freeze([]),
});
