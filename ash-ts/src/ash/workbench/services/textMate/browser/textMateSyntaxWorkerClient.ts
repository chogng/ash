import { type SyntaxWorkerFactory } from "../../../../editor/common/languages/syntax/syntaxService.js";
import { BrowserWorkerClientPort } from "../../../../platform/webWorker/browser/browserWorkerClientPort.js";
import { TextMateSyntaxModuleWorkerClient } from "../common/textMateSyntaxModuleWorkerClient.js";
import { type TextMateGrammarCatalogSource } from "../common/textMateGrammarCatalog.js";
import { type TextMateScopeThemeSource } from "../common/textMateScopeTheme.js";

/** Creates a Syntax Worker gated by a renderer-owned TextMate grammar catalog. */
export function createTextMateSyntaxWorkerFactory(catalogs: TextMateGrammarCatalogSource, scopeTheme?: TextMateScopeThemeSource): SyntaxWorkerFactory {
	if (!catalogs || typeof catalogs !== "object" || typeof catalogs.onDidChangeCatalog !== "function" || !("currentCatalog" in catalogs)) {
		throw new TypeError("TextMate Syntax Worker factory requires a grammar catalog source");
	}
	if (scopeTheme !== undefined && !isThemeSource(scopeTheme)) {
		throw new TypeError("TextMate Syntax Worker factory scope theme must be a theme source");
	}
	return () => new TextMateSyntaxModuleWorkerClient(
		new BrowserWorkerClientPort(new Worker(
			new URL("./textMateSyntaxWorkerMain.ts", import.meta.url),
			{ type: "module", name: "ash-textmate-syntax" },
		)),
		catalogs,
		{
			requiredProviderModules: ["textmate.grammars"],
			...(scopeTheme === undefined ? {} : { scopeTheme }),
		},
	);
}

function isThemeSource(value: unknown): value is TextMateScopeThemeSource {
	return typeof value === "object" && value !== null && "currentTheme" in value && typeof (value as TextMateScopeThemeSource).onDidChangeTheme === "function";
}
