import { localize, localize2 } from '../../../../nls.js';
import { ExternalUriOpenerPriority } from '../../../../editor/common/languages.js';
import { IExternalUriOpenerService, type IExternalUriOpener } from '../../externalUriOpener/common/externalUriOpenerService.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { EditorPanes } from '../../../browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserEditor } from './browserEditor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

import { BrowserEditorSerializer } from '../common/browserEditorInput.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { BrowserViewEditorId, IBrowserViewWorkbenchService } from '../common/browserView.js';
import { BrowserViewWorkbenchService } from './browserViewWorkbenchService.js';
import { EditorInputSerializers } from '../../../services/editor/common/editorInputSerializer.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IBrowserZoomService, BrowserZoomService } from '../common/browserZoomService.js';
import './features/browserTabManagementFeatures.js';

registerSingleton(IBrowserViewWorkbenchService, BrowserViewWorkbenchService, InstantiationType.Delayed);
registerSingleton(IBrowserZoomService, BrowserZoomService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.browser', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Browser accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Browser accessibility help', description: 'Announce keyboard help when the browser address field receives focus.' },
});


registerWorkbenchContribution('workbench.contrib.browserView', WorkbenchPhase.BlockRestore, services => {
	const store = new DisposableStore();
	const instantiation = services.get(IInstantiationService);
	const views = services.get(IBrowserViewWorkbenchService);
	const configuration = services.get(IConfigurationService);
	store.add(bindNavigationContext(services));
	store.add(services.get(IExternalUriOpenerService).registerExternalOpenerProvider({
		async *getOpeners(): AsyncIterable<IExternalUriOpener> {
			yield {
				id: 'ash.browser.open',
				label: localize('browser.urlOpener', 'Open in Ash browser'),
				// Offer the browser for explicit URL rules without changing ordinary link opening.
				canOpen: async uri => configuration.getValue<boolean>('workbench.browser.openLocalhostLinks') && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(uri.toString()).hostname) ? ExternalUriOpenerPriority.Preferred : ExternalUriOpenerPriority.Option,
				openExternalUri: async uri => {
					await views.createBrowserView({ initialUrl: uri.toString(), owner: { type: 'user' } });
					return true;
				},
			};
		},
	}));
	store.add(EditorInputSerializers.register(instantiation.createInstance(BrowserEditorSerializer)));
	void views.initialize().catch(error => console.error('Failed to read browser pages', error));
	store.add(EditorPanes.registerEditorPane({
		id: BrowserViewEditorId, name: 'Browser',
		canOpen: input => BrowserViewUri.parse(input.resource) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => instantiation.createInstance(BrowserEditor),
	}));

	return store;
});

registerWorkbenchContribution('workbench.contrib.browserView.restore', WorkbenchPhase.AfterRestored, services => {
	const instantiation = services.get(IInstantiationService);
	const views = instantiation.get(IBrowserViewWorkbenchService);
	const editors = services.get(IEditorService);
	const editorPart = services.get(IEditorPart);
	void views.initialize().then(async () => {
		for (const input of views.getContextualBrowserViews().values()) {
			if (!editorPart.groups.some(group => group.inputs.some(candidate => extUri.isEqual(candidate.resource, input.resource)))) {
				await editors.openEditor(input, { pinned: true, preserveFocus: true });
			}
		}
	}).catch(error => console.error('Failed to restore browser pages', error));
	return Disposable.None;
});

import '../browser/browserView.contribution.js';
import './features/browserDevToolsFeature.js';
import './features/browserDataStorageFeatures.js';

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

import { BrowserNavigationFeatures, CONTEXT_BROWSER_CAN_GO_BACK, CONTEXT_BROWSER_CAN_GO_FORWARD } from './features/browserNavigationFeatures.js';
import { BrowserEditorErrorFeatures } from './features/browserEditorErrorFeatures.js';
import { WebContentsViewRendererFeature } from './features/webContentsViewRendererFeature.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';

import { BrowserEditorChatIntegration } from './features/browserEditorChatFeatures.js';
import { BrowserEditorFindFeature } from './features/browserEditorFindFeature.js';

BrowserEditor.registerContribution(BrowserNavigationFeatures);
BrowserEditor.registerContribution(BrowserEditorErrorFeatures);
BrowserEditor.registerContribution(WebContentsViewRendererFeature);
BrowserEditor.registerContribution(BrowserEditorChatIntegration);
BrowserEditor.registerContribution(BrowserEditorFindFeature);

function bindNavigationContext(services: ServicesAccessor): DisposableStore {
	const store = new DisposableStore();
	// The command palette is outside the pane DOM, so its history keys follow only the active pane.
	const active = store.add(new DisposableStore());
	const editors = services.get(IEditorPart);
	const contexts = services.get(IContextKeyService);
	const back = CONTEXT_BROWSER_CAN_GO_BACK.bindTo(contexts);
	const forward = CONTEXT_BROWSER_CAN_GO_FORWARD.bindTo(contexts);
	const update = (): void => {
		active.clear();
		const pane = editors.activePane;
		const render = (): void => contexts.bufferChangeEvents(() => {
			back.set(pane instanceof BrowserEditor && pane.model?.state.canGoBack === true);
			forward.set(pane instanceof BrowserEditor && pane.model?.state.canGoForward === true);
		});
		if (pane instanceof BrowserEditor) {
			active.add(pane.onDidChangeModel(update));
			if (pane.model) { active.add(pane.model.onDidChangeState(render)); }
		}
		render();
	};
	store.add(editors.onDidChangeEditors(update));
	store.add(toDisposable(() => { back.reset(); forward.reset(); }));
	update();
	return store;
}
