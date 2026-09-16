import { type IDisposable } from '../../../base/common/lifecycle.js';
import { type ICodeEditorService } from './codeEditorService.js';
import { BrowserWorkerClientPort } from '../../../platform/webWorker/browser/browserWorkerClientPort.js';
import { LanguageCompletionCatalogWorkerClient } from '../../common/languages/completion/languageCompletionCatalogWire.js';
import { type LanguageCompletionWorkerFactory } from '../../common/languages/completion/languageCompletionService.js';
import { type SyntaxWorkerFactory } from '../../common/languages/syntax/syntaxService.js';
import { SyntaxModuleWorkerClient } from '../../common/languages/syntax/syntaxModuleWorkerClient.js';
import { VersionedEditorWorkerClient, type VersionedEditorWorkerFactory } from './editorWorkerService.js';
import { NullRenameSymbolTrackerService } from './renameSymbolTrackerService.js';
import { OpenerService } from './openerService.js';

export function registerEditorBrowserContributions(): void {
}

export interface EditorBrowserServices {
	readonly codeEditorService: ICodeEditorService & IDisposable;
	readonly workers: {
		readonly editorWorkerFactory: VersionedEditorWorkerFactory;
		readonly syntaxWorkerFactory: SyntaxWorkerFactory;
		readonly completionWorkerFactory: LanguageCompletionWorkerFactory;
	};
	readonly renameSymbolTrackerService: NullRenameSymbolTrackerService;
	readonly openerService: OpenerService;
}

/** Creates the browser-owned editor services used by a composition root. */
export function createEditorBrowserServices(codeEditorService: ICodeEditorService & IDisposable): EditorBrowserServices {
	return Object.freeze({
		codeEditorService,
		workers: createWorkers(),
		renameSymbolTrackerService: new NullRenameSymbolTrackerService(),
		openerService: new OpenerService(codeEditorService),
	});
}

function createWorkers(): EditorBrowserServices['workers'] {
	return Object.freeze({
		editorWorkerFactory: (model) => new VersionedEditorWorkerClient(model),
		syntaxWorkerFactory: () => new SyntaxModuleWorkerClient(
			new BrowserWorkerClientPort(new Worker(new URL('./syntaxWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-syntax' })),
			{ requiredProviderModules: ['language.lexical'] },
		),
		completionWorkerFactory: () => new LanguageCompletionCatalogWorkerClient(
			new BrowserWorkerClientPort(new Worker(new URL('./languageCompletionWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-completion' })),
			{ requiredProviderModules: ['language.word'] },
		),
	});
}
