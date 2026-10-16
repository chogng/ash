import { editorLanguageForSyntaxLanguage, syntaxLanguageForEditorLanguage } from '../../../../platform/syntax/common/syntaxApi.js';
import { treeSitterChannel } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { start } from '../../../../editor/editor.worker.start.js';
import { WebWorkerServer } from '../../../../base/common/worker/webWorker.js';
import { TreeSitterWorker } from '../../../../editor/common/services/treeSitter/treeSitterWorker.js';
import { TreeSitterWasmLibrary } from './treeSitterWasmLibrary.js';
import { getLanguageFoldingRules } from '../../../../platform/language/common/languageFolding.generated.js';

start(({ port, resources }) => {
	const library = resources.add(new TreeSitterWasmLibrary());
	const load = async (languageId: string): Promise<import('../../../../editor/common/model/tokens/treeSitter/treeSitterTree.js').TreeSitterTokenizationRuntime | undefined> => {
		if (!library.supportsLanguage(languageId)) return undefined;
		const [Parser, language] = await Promise.all([library.getParserClass(), library.getLanguagePromise(languageId)]);
		const query = library.getHighlightingQueries(languageId);
		if (!language || !query) throw new Error(`Missing Tree-sitter grammar for ${languageId}`);
		const editorLanguage = editorLanguageForSyntaxLanguage(syntaxLanguageForEditorLanguage(languageId)!);
		return { Parser, language, languageId: editorLanguage, foldingRules: getLanguageFoldingRules(editorLanguage), query, symbols: library.getSymbolQueries(languageId), folds: library.getFoldingQueries(languageId), injections: library.getInjectionQueries(languageId), loadEmbeddedLanguage: load };
	};
	const worker = resources.add(new TreeSitterWorker(async languageId => {
		const runtime = await load(languageId);
		if (!runtime) throw new Error(`Missing Tree-sitter grammar for ${languageId}`);
		return runtime;
	}));
	resources.add(new WebWorkerServer(port, treeSitterChannel, worker));
});
