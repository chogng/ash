import { BrowserNavigationFeatures } from './browserNavigationFeatures.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IBrowserViewService } from '../../../../../platform/browserView/common/browserView.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import type { IBrowserViewModel } from '../../common/browserView.js';

/** History UI borrows the attached page; Main owns visits and their persistence. */
export class BrowserHistoryFeature extends Disposable {
	private model: IBrowserViewModel | undefined;
	private readonly historyPicker = this._register(new MutableDisposable<DisposableStore>());
	constructor(private readonly report: (error: unknown) => void,
		@IBrowserViewService private readonly pageService: IBrowserViewService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) { super(); }
	public setModel(model: IBrowserViewModel | undefined): void {
		this.historyPicker.clear();
		this.model = model;
	}
	public readonly urlSuggestionProviders: readonly import('../browserEditor.js').IBrowserUrlSuggestionProvider[] = [{
		get label() { return localize({ bundle: 'ash.workbench', key: 'browser.history' }, 'History'); }, order: 10,
		getSuggestions: async ({ text, input }, token) => {
			const model = input.model;
			if (!model || token.isCancellationRequested || !['global', 'workspace'].includes(model.info.session.scope)) { return []; }
			const snapshot = await this.pageService.getBrowserHistory(model.id);
			if (token.isCancellationRequested) { return []; }
			return [...snapshot.items].reverse().filter(entry => (entry.title + ' ' + entry.url).toLowerCase().includes(text.toLowerCase())).slice(0, 50).map(entry => ({ id: 'history:' + entry.id, label: entry.title || entry.url, description: entry.url, apply: input => input.model?.loadURL(entry.url) }));
		},
	}];
	public async show(): Promise<void> {
		const model = this.model;
		if (!model) { return; }
		const snapshot = await this.pageService.getBrowserHistory(model.id);
		if (this.isDisposed || this.model !== model) { return; }
		const resources = new DisposableStore();
		this.historyPicker.value = resources;
		const picker = resources.add(this.quickInput.createQuickPick<IQuickPickItem & { url?: string; }>());
		resources.add(toDisposable(() => picker.hide()));
		picker.ariaLabel = localize({ bundle: 'ash.workbench', key: 'browser.history' }, 'History');
		picker.placeholder = localize({ bundle: 'ash.workbench', key: 'browser.historySearch' }, 'Search browsing history');
		picker.sortByLabel = false;
		const items = [...snapshot.items].reverse().map(entry => ({ label: entry.title || entry.url, description: entry.url, url: entry.url }));
		const render = (): void => {
			picker.items = [...filterQuickPickItems(items, picker.value), { label: localize({ bundle: 'ash.workbench', key: 'browser.clearHistory' }, 'Clear browsing history'), alwaysShow: true }];
		};
		resources.add(picker.onDidChangeValue(render));
		resources.add(picker.onDidHide(() => { if (this.historyPicker.value === resources) { this.historyPicker.clear(); } }));
		resources.add(picker.onDidAccept(() => {
			const selected = picker.selectedItems[0];
			if (!selected || this.model !== model) { return; }
			picker.hide();
			void (selected.url ? model.loadURL(selected.url) : this.pageService.deleteBrowserHistory(model.id)).catch(error => this.report(error));
		}));
		render();
		picker.show();
	}
	protected override disposeCore(): void { this.setModel(undefined); super.disposeCore(); }
}

import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserViewEditorId } from '../../common/browserView.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { localize2 } from '../../../../../nls.js';
import type { BrowserEditor } from '../browserEditor.js';
registerAction2(class BrowserFeatureAction extends Action2 {
	constructor() { super({ id: BrowserViewCommandId.ShowHistory, title: localize2({ bundle: 'ash.workbench', key: 'browser.historyCommand' }, 'Browser: Show History'), f1: true, precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId) }); }
	override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorPart).activePane;
		if (pane?.id === BrowserViewEditorId) { await (pane as BrowserEditor).getContribution(BrowserNavigationFeatures)?.history.show(); }
	}
});
