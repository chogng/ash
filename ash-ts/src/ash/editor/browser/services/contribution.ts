import { AbstractCodeEditorService } from './abstractCodeEditorService.js';
import { DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../editorBrowser.js';
import { BrowserWorkerClientPort } from '../../../platform/webWorker/browser/browserWorkerClientPort.js';
import { LanguageCompletionCatalogWorkerClient } from '../../common/languages/completion/languageCompletionCatalogWire.js';
import { type LanguageCompletionWorkerFactory } from '../../common/languages/completion/languageCompletionService.js';
import { LanguageWorkerWireClient } from '../../common/languages/languageWorkerWire.js';
import { type SyntaxWorkerFactory } from '../../common/languages/syntax/syntaxService.js';
import { SyntaxModuleWorkerClient } from '../../common/languages/syntax/syntaxModuleWorkerClient.js';
import { VersionedEditorWorkerClient, type VersionedEditorWorkerFactory } from './editorWorkerService.js';
import { editorWorkerWireCodec } from '../../common/services/editorWorkerWire.js';
import { NullRenameSymbolTrackerService } from './renameSymbolTrackerService.js';
import { OpenerService } from './openerService.js';

export function registerEditorBrowserContributions(): void {
}

class BrowserCodeEditorService extends AbstractCodeEditorService {
	private readonly recentEditors: ICodeEditor[] = [];
	private readonly focusListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());

	constructor() {
		super();
		this._register(toDisposable(() => { this.recentEditors.length = 0; }));
		this._register(this.onCodeEditorAdd(editor => {
			if (!this.recentEditors.includes(editor)) this.recentEditors.unshift(editor);
			const listeners = new DisposableStore();
			this.focusListeners.set(editor, listeners);
			listeners.add(editor.onDidFocusEditorText(() => this.markActive(editor)));
			listeners.add(editor.onDidFocusEditorWidget(() => this.markActive(editor)));
			if (editor.hasWidgetFocus()) this.markActive(editor);
		}));
		this._register(this.onCodeEditorRemove(editor => {
			this.focusListeners.deleteAndDispose(editor);
			const index = this.recentEditors.indexOf(editor);
			if (index >= 0) this.recentEditors.splice(index, 1);
		}));
	}

	getActiveCodeEditor(): import('../editorBrowser.js').ICodeEditor | null {
		return this.getFocusedCodeEditor() ?? this.recentEditors.at(-1) ?? null;
	}

	private markActive(editor: ICodeEditor): void {
		const index = this.recentEditors.indexOf(editor);
		if (index >= 0) this.recentEditors.splice(index, 1);
		this.recentEditors.push(editor);
	}
}

export interface EditorBrowserServices {
	readonly codeEditorService: BrowserCodeEditorService;
	readonly workers: {
		readonly editorWorkerFactory: VersionedEditorWorkerFactory;
		readonly syntaxWorkerFactory: SyntaxWorkerFactory;
		readonly completionWorkerFactory: LanguageCompletionWorkerFactory;
	};
	readonly renameSymbolTrackerService: NullRenameSymbolTrackerService;
	readonly openerService: OpenerService;
}

/** Creates the browser-owned editor services used by a composition root. */
export function createEditorBrowserServices(): EditorBrowserServices {
	const codeEditorService = new BrowserCodeEditorService();
	return Object.freeze({
		codeEditorService,
		workers: createWorkers(),
		renameSymbolTrackerService: new NullRenameSymbolTrackerService(),
		openerService: new OpenerService(codeEditorService),
	});
}

function createWorkers(): EditorBrowserServices['workers'] {
	return Object.freeze({
		editorWorkerFactory: (model) => new VersionedEditorWorkerClient(
			model,
			() => new LanguageWorkerWireClient(
				new BrowserWorkerClientPort(new Worker(new URL('../../common/services/editorWebWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-editor' })),
				editorWorkerWireCodec,
			),
		),
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
