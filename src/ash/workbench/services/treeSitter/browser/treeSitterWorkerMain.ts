import { editorLanguageForSyntaxLanguage, syntaxLanguageForEditorLanguage } from '../../../../platform/syntax/common/syntaxApi.js';
import { treeSitterChannel } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { start } from '../../../../editor/editor.worker.start.js';
import { WebWorkerServer } from '../../../../base/common/worker/webWorker.js';
import { TreeSitterWorker } from '../../../../editor/common/services/treeSitter/treeSitterWorker.js';
import { TreeSitterWasmLibrary } from './treeSitterWasmLibrary.js';
import { getLanguageFoldingRules } from '../../../../platform/language/common/languageFolding.generated.js';
import { extensionTreeSitterWorkerChannel, type ExtensionTreeSitterWorkerHost } from '../common/extensionTreeSitterGrammar.js';

start(({ port, resources }) => {
	const library = resources.add(new TreeSitterWasmLibrary({
		getGrammar: languageId => server.getChannel<ExtensionTreeSitterWorkerHost>(extensionTreeSitterWorkerChannel).getGrammar(languageId),
	}));
	const load = async (languageId: string): Promise<import('../../../../editor/common/services/treeSitter/treeSitterTree.js').TreeSitterTokenizationRuntime | undefined> => {
		const builtin = syntaxLanguageForEditorLanguage(languageId);
		const grammarId = builtin ?? languageId;
		const language = await library.getLanguagePromise(grammarId);
		if (!language) return undefined;
		const Parser = await library.getParserClass();
		const query = library.getHighlightingQueries(grammarId);
		if (!query) throw new Error(`Missing Tree-sitter grammar for ${languageId}`);
		const editorLanguage = builtin ? editorLanguageForSyntaxLanguage(builtin) : languageId;
		return { Parser, language, languageId: editorLanguage, foldingRules: getLanguageFoldingRules(editorLanguage), query, symbols: library.getSymbolQueries(grammarId), folds: library.getFoldingQueries(grammarId), injections: library.getInjectionQueries(grammarId), loadEmbeddedLanguage: load };
	};
	const worker = resources.add(new TreeSitterWorker(async languageId => {
		const runtime = await load(languageId);
		if (!runtime) throw new Error(`Missing Tree-sitter grammar for ${languageId}`);
		return runtime;
	}));
	const server = resources.add(new WebWorkerServer(port, treeSitterChannel, worker));
});
