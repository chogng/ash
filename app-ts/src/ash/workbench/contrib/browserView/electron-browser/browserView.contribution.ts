import { localize2 } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IBrowserViewApi, type IBrowserViewState } from '../../../../platform/browser/common/browserView.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { EditorPanes } from '../../../browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserEditor } from './browserEditor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

const BROWSER_RESOURCE_SCHEME = 'ash-browser';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.browser', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Browser accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Browser accessibility help', description: 'Announce keyboard help when the browser address field receives focus.' },
});

class BrowserEditorInput extends Disposable implements EditorInput {
	readonly resource: URI;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;
	private readonly labelChange = this._register(new Emitter<void>());
	readonly onDidChangeLabel = this.labelChange.event;
	private state: IBrowserViewState;

	constructor(state: IBrowserViewState) {
		super();
		this.resource = URI.parse(`${BROWSER_RESOURCE_SCHEME}:/${state.targetId}`);
		this.state = state;
	}

	get label(): string {
		if (this.state.url === 'about:blank') { return 'Browser'; }
		if (this.state.title.trim()) { return this.state.title.trim(); }
		return new URL(this.state.url).host;
	}

	update(state: IBrowserViewState): void {
		const label = this.label;
		this.state = state;
		if (this.label !== label) { this.labelChange.fire(); }
	}
}

registerWorkbenchContribution('workbench.contrib.browserView', WorkbenchPhase.BlockRestore, services => {
	const store = new DisposableStore();
	const inputs = store.add(new DisposableMap<string, BrowserEditorInput>());
	const api = services.get(IBrowserViewApi);
	const editors = services.get(IEditorService);
	const editorPart = services.get(IEditorPart);
	const instantiation = services.get(IInstantiationService);
	store.add(EditorPanes.registerEditorPane({
		id: BrowserEditor.ID, name: 'Browser',
		canOpen: input => input.resource.scheme === BROWSER_RESOURCE_SCHEME ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => instantiation.createInstance(BrowserEditor),
	}));
	const subscription = api.onDidEvent(event => {
		if (event.type === 'created') {
			const input = new BrowserEditorInput(event.state);
			inputs.set(event.state.targetId, input);
			void editors.openEditor(input, { pinned: true })
				.catch(error => { console.error('Failed to open browser editor', error); void api.close({ targetId: event.state.targetId }); });
		}
		if (event.type === 'stateChanged') { inputs.get(event.state.targetId)?.update(event.state); }
		if (event.type === 'closed') {
			inputs.deleteAndDispose(event.targetId);
			const resource = URI.parse(`${BROWSER_RESOURCE_SCHEME}:/${event.targetId}`);
			for (const group of editorPart.groups) {
				for (const input of group.inputs) {
					if (extUri.isEqual(input.resource, resource)) {
						void group.closeEditor(input).catch(error => console.error('Failed to close browser editor', error));
					}
				}
			}
		}
	});
	store.add(toDisposable(() => subscription.dispose()));
	store.add(editorPart.onDidChangeEditors(event => {
		if (event.kind !== 'groupChanged' || event.event.kind !== 'editorClosed') { return; }
		const resource = event.event.editor.input.resource;
		if (resource.scheme !== BROWSER_RESOURCE_SCHEME) { return; }
		const targetId = resource.path.slice(1);
		if (!inputs.has(targetId)) { return; }
		if (editorPart.groups.some(group => group.inputs.some(input => extUri.isEqual(input.resource, resource)))) { return; }
		void api.close({ targetId }).catch(error => console.error('Failed to close browser page', error));
	}));
	store.add(registerAction2(class OpenBrowser extends Action2 {
		constructor() { super({ id: 'ash.browser.open', title: localize2({ bundle: 'ash.workbench', key: 'command.OpenBrowser' }, 'Browser: Open Browser'), f1: true }); }
		override async run(): Promise<void> { await api.create({ url: 'about:blank' }); }
	}));
	return store;
});
