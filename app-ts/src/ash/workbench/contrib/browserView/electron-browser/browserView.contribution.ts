import { localize, localize2 } from '../../../../nls.js';
import { ExternalUriOpenerPriority } from '../../../../editor/common/languages.js';
import { IExternalUriOpenerService, type IExternalUriOpener } from '../../externalUriOpener/common/externalUriOpenerService.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { EditorPanes } from '../../../browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserEditor } from './browserEditor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

import { BrowserEditorSerializer, BROWSER_RESOURCE_SCHEME } from '../common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../common/browserView.js';
import { BrowserViewWorkbenchService } from './browserViewWorkbenchService.js';
import { EditorInputSerializers } from '../../../services/editor/common/editorInputSerializer.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

registerSingleton(IBrowserViewWorkbenchService, BrowserViewWorkbenchService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.browser', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Browser accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Browser accessibility help', description: 'Announce keyboard help when the browser address field receives focus.' },
});


registerWorkbenchContribution('workbench.contrib.browserView', WorkbenchPhase.BlockRestore, services => {
	const store = new DisposableStore();
	const instantiation = services.get(IInstantiationService);
	const views = services.get(IBrowserViewWorkbenchService);
	store.add(services.get(IExternalUriOpenerService).registerExternalOpenerProvider({
		async *getOpeners(): AsyncIterable<IExternalUriOpener> {
			yield {
				id: 'ash.browser.open',
				label: localize('browser.urlOpener', 'Open in Ash browser'),
				// Offer the browser for explicit URL rules without changing ordinary link opening.
				canOpen: async () => ExternalUriOpenerPriority.Option,
				openExternalUri: async uri => {
					await views.createBrowserView({ initialUrl: uri.toString(), owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace } });
					return true;
				},
			};
		},
	}));
	store.add(EditorInputSerializers.register(instantiation.createInstance(BrowserEditorSerializer)));
	void views.initialize().catch(error => console.error('Failed to read browser pages', error));
	store.add(EditorPanes.registerEditorPane({
		id: BrowserEditor.ID, name: 'Browser',
		canOpen: input => input.resource.scheme === BROWSER_RESOURCE_SCHEME ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => instantiation.createInstance(BrowserEditor),
	}));
	store.add(registerAction2(class OpenBrowser extends Action2 {
		constructor() { super({ id: 'ash.browser.open', title: localize2({ bundle: 'ash.workbench', key: 'command.OpenBrowser' }, 'Browser: Open Browser'), f1: true }); }
		override async run(): Promise<void> { await views.createBrowserView({ initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace } }); }
	}));
	return store;
});

registerWorkbenchContribution('workbench.contrib.browserView.restore', WorkbenchPhase.AfterRestored, services => {
	const instantiation = services.get(IInstantiationService);
	const views = instantiation.get(IBrowserViewWorkbenchService);
	const editors = services.get(IEditorService);
	const editorPart = services.get(IEditorPart);
	void views.initialize().then(async () => {
		for (const input of views.getKnownBrowserViews().values()) {
			if (!editorPart.groups.some(group => group.inputs.some(candidate => extUri.isEqual(candidate.resource, input.resource)))) {
				await editors.openEditor(input, { pinned: true, preserveFocus: true });
			}
		}
	}).catch(error => console.error('Failed to restore browser pages', error));
	return Disposable.None;
});
