import { Emitter } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';
import type { ServerNotification } from '../../../src/ash/platform/app-server/common/generated/index.js';
import { createDisconnectedLanguageApi } from '../../../src/ash/platform/language/browser/languageApi.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { AppServerLanguageProviders } from '../../../src/ash/workbench/services/language/browser/appServerLanguageProviders.js';

const store = new DisposableStore();
const changes = store.add(new Emitter<ServerNotification>());
const workspace = store.add(new WorkspaceContextService({ id: 'workspace', uri: stanza.URI.file('/project') }));
const model = store.add(stanza.editor.createModel('pri', 'python', stanza.URI.file('/project/main.py')));
const editor = store.add(stanza.editor.create(document.querySelector<HTMLElement>('#editor')!, { model }));
const features = StandaloneServices.get().instantiationService.get(ILanguageFeaturesService);
let installed = false;
let generation = 0;
let requests = 0;
const api = createDisconnectedLanguageApi(operation => { throw new Error(`Unexpected operation: ${operation}`); });
api.servers = async () => ({ servers: installed ? [{ id: 'pyright', languageIds: ['python'] }] : [] });
api.foldingRanges = async ({ document }) => ({ revision: document.revision, ranges: [] });
api.linkedEditingRanges = async ({ document }) => ({ revision: document.revision, ranges: [], wordPattern: null });
api.semanticTokens = async ({ document }) => ({ revision: document.revision, resultId: null, tokens: [] });
api.documentColors = async ({ document }) => ({ revision: document.revision, colors: [] });
api.codeLenses = async ({ document }) => ({ revision: document.revision, lenses: [] });
api.documentLinks = async ({ document }) => ({ revision: document.revision, links: [] });
api.inlayHints = async ({ document }) => ({ revision: document.revision, hints: [] });
api.completions = async params => {
	requests += 1;
	return {
		revision: params.document.revision, isIncomplete: false, canResolve: false,
		items: [{
			label: 'print_from_server', kind: 'function', insertText: 'print_from_server', insertTextFormat: 'plainText',
			range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 3 } },
			detail: null, documentation: null, filterText: null, sortText: null, preselect: null,
			commitCharacters: [], additionalTextEdits: [], command: null, providerData: null,
		}],
	};
};
store.add(new AppServerLanguageProviders(features, api, workspace, { events: { subscribe: listener => changes.event(listener) } }));
for (const [id, value] of [['install', true], ['uninstall', false]] as const) {
	store.add(addDisposableListener(document.getElementById(id)!, 'click', () => {
		installed = value;
		changes.fire({ method: 'marketplace/changed', params: { instanceId: 'browser-test', generation: ++generation } });
	}));
}

declare global {
	interface Window {
		languageIntegration: { registered(): boolean; requests(): number; focus(): void; dispose(): void };
	}
}
window.languageIntegration = {
	registered: () => features.completionProvider.getProvider('ash.appServer.completions')?.languageIds.includes('python') ?? false,
	requests: () => requests,
	focus: () => { editor.setPosition(new stanza.Position(1, 4)); editor.focus(); },
	dispose: () => store.dispose(),
};
