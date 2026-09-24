import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IBrowserViewApi } from '../../../../platform/browser/common/browserView.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { EditorPanes } from '../../../browser/parts/editor/editorRegistry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserEditor } from './browserEditor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.browser', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Browser accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Browser accessibility help', description: 'Announce keyboard help when the browser address field receives focus.' },
});

registerWorkbenchContribution('workbench.contrib.browserView', WorkbenchPhase.BlockRestore, services => {
	const store = new DisposableStore();
	const api = services.get(IBrowserViewApi);
	const editors = services.get(IEditorService);
	const editorPart = services.get(IEditorPart);
	const instantiation = services.get(IInstantiationService);
	store.add(EditorPanes.register({
		id: BrowserEditor.ID, name: 'Browser',
		canOpen: input => input.resource.scheme === 'ash-browser' ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => instantiation.createInstance(BrowserEditor),
	}));
	const subscription = api.onDidEvent(event => {
		if (event.type === 'created') {
			void editors.openEditor({ resource: URI.parse(`ash-browser:/${event.state.targetId}`), label: 'Browser', readOnly: true, showBreadcrumbs: false }, { pinned: true })
				.catch(error => { console.error('Failed to open browser editor', error); void api.close({ targetId: event.state.targetId }); });
		}
		if (event.type === 'closed') {
			const resource = URI.parse(`ash-browser:/${event.targetId}`).toString();
			for (const group of editorPart.groups) {
				for (const input of group.inputs) {
					if (input.resource.toString() === resource) {
						void group.closeEditor(input).catch(error => console.error('Failed to close browser editor', error));
					}
				}
			}
		}
	});
	store.add(toDisposable(() => subscription.dispose()));
	store.add(registerAction2(class OpenBrowser extends Action2 {
		constructor() { super({ id: 'ash.browser.open', title: 'Browser: Open Browser', f1: true }); }
		override async run(): Promise<void> { await api.create({ url: 'about:blank' }); }
	}));
	return store;
});
