import { start } from "../../../../editor/editor.worker.start.js";
import { SyntaxProviderRegistry } from '../../../../editor/common/languageFeatureRegistry.js';
import { SyntaxProviderWorker } from '../../../../editor/common/services/editorWebWorker.js';
import { createTextMateSyntaxProvider } from "../common/textMateSyntaxProvider.js";
import { TextMateGrammarCatalogStore } from "../common/textMateGrammarCatalogStore.js";
import { TextMateGrammarCatalogWireServer } from "../common/textMateGrammarCatalogWire.js";
import { TextMateScopeThemeModel } from "../common/textMateScopeTheme.js";
import { TextMateScopeThemeWireServer } from "../common/textMateScopeThemeWire.js";
import { createBrowserTextMateTokenizationService } from "./browserTextMateTokenization.js";
import { syntaxWireCodec } from '../../../../editor/common/services/semanticTokensDto.js';
import { WorkerTextModelSyncServer } from '../../../../editor/common/services/textModelSync/textModelSync.impl.js';

start(({ port, resources }) => {
	const registry = resources.add(new SyntaxProviderRegistry());
	const grammarCatalog = resources.add(new TextMateGrammarCatalogStore());
	const scopeTheme = resources.add(new TextMateScopeThemeModel());
	const textMateTokenization = resources.add(createBrowserTextMateTokenizationService(grammarCatalog, {
		scopeResolver: scopes => scopeTheme.resolve(scopes),
	}));
	resources.add(registry.register(createTextMateSyntaxProvider(textMateTokenization)));
	resources.add(new WorkerTextModelSyncServer(port, syntaxWireCodec, new SyntaxProviderWorker(registry)));
	resources.add(new TextMateGrammarCatalogWireServer(port, grammarCatalog));
	resources.add(new TextMateScopeThemeWireServer(port, scopeTheme, () => textMateTokenization.invalidateTokenCaches()));
});
