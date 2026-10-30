import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { h } from '../../../../../base/browser/dom.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, CONTEXT_BROWSER_HAS_ERROR, CONTEXT_BROWSER_HAS_URL, type IBrowserEditorWidget } from '../browserEditor.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import { BrowserHistoryFeature } from './browserHistoryFeature.js';
import { BrowserPermissionsFeature } from './browserPermissionsFeature.js';
import { BrowserEditorZoomSupport } from './browserEditorZoomFeature.js';
import { BrowserEditorEmulationSupport } from './browserEditorEmulationFeatures.js';
import { BrowserFavoritesFeature } from './browserFavoritesFeature.js';
import { BrowserRemoteIndicatorContribution } from './browserRemoteFeatures.js';
import { IBrowserAutoReloadService } from './browserAutoReloadFeatures.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { BrowserElementSelectionMode, BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { ContextKeyExpr, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import type { IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CONTEXT_BROWSER_DEVTOOLS_OPEN } from './browserDevToolsFeature.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import type { IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { BrowserUrlBarWidget, type IBrowserUrlBarHost, type IUrlPickerItem } from '../widgets/browserUrlBarWidget.js';
import { BrowserSearchFeatures } from './browserSearchFeatures.js';
import { BROWSER_SEARCH_NONE, BrowserSearchEngineId, BrowserSearchEngineSettingId, buildSearchUrl, resolveAddressBarInputType } from '../../common/browserSearch.js';

export const CONTEXT_BROWSER_CAN_GO_BACK = new RawContextKey<boolean>('browserCanGoBack', false);
export const CONTEXT_BROWSER_CAN_GO_FORWARD = new RawContextKey<boolean>('browserCanGoForward', false);

/** Owns the navigation widgets and keeps action identities stable across title changes. */
export class BrowserNavigationFeatures extends BrowserEditorContribution {
	public readonly address: BrowserUrlBarWidget;
	private readonly toolbar: WorkbenchToolBar;
	private readonly search: BrowserSearchFeatures;
	private actions: readonly IAction[] = [];
	private readonly container: HTMLElement;
	private readonly sharingToolbar: WorkbenchToolBar;
	private readonly pageContexts: IContextKeyService;
	private readonly devToolsContext: IContextKey<boolean>;
	private readonly hasUrlContext: IContextKey<boolean>;
	private readonly hasErrorContext: IContextKey<boolean>;
	private readonly remoteIndicator: BrowserRemoteIndicatorContribution;
	readonly history: BrowserHistoryFeature;
	readonly permissions: BrowserPermissionsFeature;
	readonly emulation: BrowserEditorEmulationSupport;
	readonly favorites: BrowserFavoritesFeature;
	private readonly zoom: BrowserEditorZoomSupport;
	private actionsUrl: string | undefined;
	private readonly report = (error: unknown): void => this.editor.report(error);
	private get host(): IBrowserUrlBarHost {
		const editor = this.editor;
		return {
			get input() { return editor.input; },
			ensureBrowserFocus: () => editor.ensureBrowserFocus(),
			getPrimaryActions: text => this.getPrimaryActions(text),
			getPlaceholder: () => this.configuration.getValue<string>(BrowserSearchEngineSettingId) === BROWSER_SEARCH_NONE
				? localize({ bundle: 'ash.workbench', key: 'browser.enterAddress' }, 'Enter a URL')
				: localize({ bundle: 'ash.workbench', key: 'browser.enterAddressOrSearch' }, 'Search or enter a URL'),
		};
	}
	constructor(editor: BrowserEditor,
		@IContextMenuService menus: IContextMenuService,
		@IInstantiationService instantiation: IInstantiationService,
		@IBrowserAutoReloadService private readonly autoReload: IBrowserAutoReloadService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contexts: IContextKeyService,
	) {
		super(editor);
		const container = this.container = h(editor.browserContainer.ownerDocument, 'div');
		container.className = 'ash-browser-toolbar';
		const navigation = h(container.ownerDocument, 'div');
		navigation.className = 'ash-browser-navigation';
		container.append(navigation);
		this.toolbar = this._register(new WorkbenchToolBar(navigation, menus, {
			ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.navigationToolbar' }, 'Browser navigation'),
			actionViewItemProvider: (action, options) => {
				if (action.id !== 'browser.reload' || !this.editor.model || this.editor.model.state.loading) {
					return undefined;
				}
				const label = localize({ bundle: 'ash.workbench', key: 'browser.reloadMenu' }, 'More Reload Actions');
				return new DropdownWithPrimaryActionViewItem(action, {
					id: 'browser.reloadMenu', label, tooltip: label, enabled: true, run: () => { },
				}, () => this.getReloadActions(), menus, options);
			},
		}));
		this.search = instantiation.createInstance(BrowserSearchFeatures);
		this.address = this._register(instantiation.createInstance(BrowserUrlBarWidget, this.host, container, (value: string) => { this.address.inputElement.value = value; return this.navigate(); }, this.report));
		this._register(addDisposableListener<KeyboardEvent>(this.address.inputElement, 'keydown', event => {
			if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); void this.navigate().catch(this.report); }
		}));
		this.history = this._register(instantiation.createInstance(BrowserHistoryFeature, this.report));
		this.zoom = this._register(instantiation.createInstance(BrowserEditorZoomSupport, this.report));
		this.emulation = this._register(instantiation.createInstance(BrowserEditorEmulationSupport));
		this.favorites = this._register(instantiation.createInstance(BrowserFavoritesFeature, () => this.setPageActions(), this.report));
		this.permissions = this._register(instantiation.createInstance(BrowserPermissionsFeature, (message: string) => editor.setStatus(message), this.report));
		this.address.mountContributions([this.history, this.favorites]);
		this.remoteIndicator = this._register(new BrowserRemoteIndicatorContribution(container));
		const sharing = h(container.ownerDocument, 'div');
		sharing.className = 'ash-browser-page-actions';
		container.append(sharing);
		// A toolbar can belong to a visible split that is not the active editor.
		this.pageContexts = this._register(contexts.createScoped(sharing));
		ActiveEditorContext.bindTo(this.pageContexts).set(BrowserViewEditorId);
		this.devToolsContext = CONTEXT_BROWSER_DEVTOOLS_OPEN.bindTo(this.pageContexts);
		this.hasUrlContext = CONTEXT_BROWSER_HAS_URL.bindTo(this.pageContexts);
		this.hasErrorContext = CONTEXT_BROWSER_HAS_ERROR.bindTo(this.pageContexts);
		this._register(new MenuWorkbenchToolBar(sharing, menuService, menus, MenuId.BrowserActionsToolbar, {
			ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.devToolsAction' }, 'Developer Tools'),
			contextKeyService: this.pageContexts,
			menuOptions: { arg: editor },
			toolbarOptions: { primaryGroup: 'tools' },
		}));
		this.sharingToolbar = this._register(new WorkbenchToolBar(sharing, menus, { ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.pageActions' }, 'Page actions') }));
		this._register(this.autoReload.onDidChangeState(() => this.update(this.editor.model?.state)));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('workbench.browser.searchEngine')) { this.address.refreshUrl(); }
		}));
		this.setPageActions();
		this.update();
	}
	override get widgets(): readonly IBrowserEditorWidget[] { return [{ location: BrowserWidgetLocation.Toolbar, element: this.container, order: 0 }]; }
	override onContainerCreated(): void {
		const root = this.editor.getContainer()!;
		const observer = new root.ownerDocument.defaultView!.ResizeObserver(() => this.onPaneResized(root.clientWidth));
		observer.observe(root);
		this._register(toDisposable(() => observer.disconnect()));
	}
	override onPaneResized(_width: number): void { this.container.classList.toggle('compact', this.container.clientWidth < 320); }
	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		this.devToolsContext.set(model.isDevToolsOpen);
		store.add(model.onDidChangeDevToolsState(event => this.devToolsContext.set(event.isDevToolsOpen)));
		this.history.setModel(model);
		this.zoom.setModel(model);
		this.emulation.setModel(model);
		this.favorites.setModel(model);
		this.permissions.setModel(model);
		this.remoteIndicator.update(model);
		this.address.refreshUrl();
		this.update(model.state);
		this.setPageActions();
		store.add(model.onDidChangeState(state => {
			this.update(state);
			if (this.actionsUrl !== state.url) { this.setPageActions(); }
		}));
	}
	override onModelDetached(): void {
		this.devToolsContext.reset();
		this.history.setModel(undefined);
		this.zoom.setModel(undefined);
		this.emulation.setModel(undefined);
		this.favorites.setModel(undefined);
		this.permissions.setModel(undefined);
		this.remoteIndicator.update(undefined);
		this.address.clear();
		this.update();
		this.setPageActions();
	}
	override tryFocus(): boolean { this.focusUrlInput(); return true; }
	private getPrimaryActions(text: string): readonly IUrlPickerItem[] {
		if (!text.trim()) { return []; }
		const url = this.search.resolve(text, true)!;
		const go: IUrlPickerItem = {
			id: 'address', label: localize({ bundle: 'ash.workbench', key: 'browser.goToAddress' }, 'Go to {0}', text),
			apply: input => input.model?.loadURL(url),
		};
		const engine = this.configuration.getValue<string>(BrowserSearchEngineSettingId);
		if (engine === BROWSER_SEARCH_NONE) { return [go]; }
		const searchUrl = buildSearchUrl(text, engine as BrowserSearchEngineId);
		const search: IUrlPickerItem = {
			id: 'search', label: localize({ bundle: 'ash.workbench', key: 'browser.searchFor' }, 'Search for {0}', text),
			apply: input => input.model?.loadURL(searchUrl),
		};
		const kind = resolveAddressBarInputType(text);
		if (kind === 'query') { return [search]; }
		return kind === 'url' ? [go, search] : [search, go];
	}
	public async navigate(): Promise<void> {
		const model = this.editor.model;
		const text = this.address.value;
		const url = this.search.resolve(text);
		if (!model || !url) { return; }
		const focused = this.address.inputElement.ownerDocument.activeElement;
		await model.loadURL(url);
		if (!this.isDisposed && this.host.input?.model === model && this.address.value === text && this.address.inputElement.ownerDocument.activeElement === focused) { this.host.ensureBrowserFocus(); }
	}
	public update(state?: IBrowserViewState): void {
		this.pageContexts.bufferChangeEvents(() => {
			this.hasUrlContext.set(!!state?.url && state.url !== 'about:blank');
			this.hasErrorContext.set(state?.errorDescription !== undefined);
		});
		this.address.previewUrl(this.editor.model?.state.url ?? '');
		const back = localize({ bundle: 'ash.workbench', key: 'browser.back' }, 'Back');
		const forward = localize({ bundle: 'ash.workbench', key: 'browser.forward' }, 'Forward');
		const reload = state?.loading ? localize({ bundle: 'ash.workbench', key: 'browser.stop' }, 'Stop') : localize({ bundle: 'ash.workbench', key: 'browser.reload' }, 'Reload');
		let reloadIcon = Lxicon.refresh;
		if (state?.loading) {
			reloadIcon = Lxicon.close;
		} else if (this.editor.model && this.autoReload.isEnabled(this.editor.model.id)) {
			reloadIcon = Lxicon.sync;
		}
		const actions: readonly IAction[] = [
			{ id: 'browser.back', label: back, tooltip: back, icon: Lxicon.arrowLeft, enabled: state?.canGoBack === true, run: () => this.host.input?.model?.goBack().catch(this.report) },
			{ id: 'browser.forward', label: forward, tooltip: forward, icon: Lxicon.arrowRight, enabled: state?.canGoForward === true, run: () => this.host.input?.model?.goForward().catch(this.report) },
			{
				id: 'browser.reload', label: reload, tooltip: reload, icon: reloadIcon, enabled: !!state, run: () => {
					const model = this.host.input?.model;
					return (model?.state.loading ? model.stop() : model?.reload())?.catch(this.report);
				}
			},
		];
		this.actions = actions.map((action, index) => {
			const previous = this.actions[index];
			return previous?.label === action.label && previous.enabled === action.enabled && previous.icon === action.icon ? previous : action;
		});
		this.toolbar.setActions(this.actions);
	}
	private getReloadActions(): readonly IAction[] {
		const model = this.editor.model;
		if (!model) {
			return [];
		}
		return [
			{
				id: BrowserViewCommandId.HardReload, label: localize({ bundle: 'ash.workbench', key: 'browser.hardReload' }, 'Reload Without Cache'),
				tooltip: '', enabled: true,
				run: () => this.editor.model === model ? model.reload(true).catch(this.report) : undefined,
			},
			{
				id: 'browser.autoReload', label: localize({ bundle: 'ash.workbench', key: 'browser.autoReload' }, 'Toggle auto reload'),
				tooltip: '', enabled: this.autoReload.canReload(model.id), checked: this.autoReload.isEnabled(model.id),
				run: () => { if (this.editor.model === model) { this.autoReload.toggle(model.id); } },
			},
		];
	}
	public focusUrlInput(): void { this.address.focusUrlInput(); }
	private target(): IBrowserViewModel {
		if (!this.editor.model) { throw new Error('Browser page is closed'); }
		return this.editor.model;
	}
	private setPageActions(): void {
		if (!this.sharingToolbar) { return; }
		this.actionsUrl = this.editor.model?.state.url;
		const go = localize({ bundle: 'ash.workbench', key: 'browser.go' }, 'Go');
		const help = localize({ bundle: 'ash.workbench', key: 'browser.help' }, 'Help');
		this.sharingToolbar.setActions([
			{ id: 'browser.go', label: go, tooltip: go, icon: Lxicon.arrowRight, enabled: true, run: () => this.navigate().catch(error => this.report(error)) },
			{ id: 'browser.help', label: help, tooltip: help, icon: Lxicon.question, enabled: true, run: () => this.editor.showHelp().catch(error => this.report(error)) },
		], [
			...this.favorites.getActions(),
			{ id: 'browser.zoom', label: localize({ bundle: 'ash.workbench', key: 'browser.zoom' }, 'Page zoom'), enabled: !!this.editor.model && this.editor.model.state.url !== 'about:blank', tooltip: '', run: () => this.zoom.show().catch(error => this.report(error)) },
			{ id: 'browser.emulation', label: localize({ bundle: 'ash.workbench', key: 'browser.emulation' }, 'Device emulation'), enabled: !!this.editor.model, tooltip: '', run: () => this.emulation.show().catch(error => this.report(error)) },
			{ id: 'browser.clearStorage', label: localize({ bundle: 'ash.workbench', key: 'browser.clearStorage' }, 'Clear data'), enabled: !!this.editor.model, tooltip: '', run: () => this.commands.executeCommand(`workbench.action.browser.clear${this.editor.model!.info.session.scope[0]!.toUpperCase() + this.editor.model!.info.session.scope.slice(1)}Storage`).catch(error => this.report(error)) },
			{ id: 'browser.find', label: localize({ bundle: 'ash.workbench', key: 'browser.find' }, 'Find in Page'), enabled: !!this.editor.model, tooltip: '', run: () => this.commands.executeCommand(BrowserViewCommandId.ShowFind).catch(error => this.report(error)) },
			{ id: 'browser.selectElement', label: localize({ bundle: 'ash.workbench', key: 'browser.selectElement' }, 'Select Element for Chat'), enabled: !!this.editor.model, tooltip: '', run: () => this.target().toggleElementSelection(true, { highlightFocusedElement: true }).catch(error => this.report(error)) },
			{ id: 'browser.commentElement', label: localize({ bundle: 'ash.workbench', key: 'browser.commentElement' }, 'Comment on Elements'), enabled: !!this.editor.model, tooltip: '', run: () => this.target().toggleElementSelection(true, { continuous: true, mode: BrowserElementSelectionMode.Comment, highlightFocusedElement: true }).catch(error => this.report(error)) },
			{ id: 'browser.selectArea', label: localize({ bundle: 'ash.workbench', key: 'browser.selectArea' }, 'Select Area for Chat'), enabled: !!this.editor.model, tooltip: '', run: () => this.target().toggleAreaSelection(true).catch(error => this.report(error)) },
			...this.permissions.getActions(),
			{ id: 'browser.history', label: localize({ bundle: 'ash.workbench', key: 'browser.history' }, 'History'), enabled: this.editor.model?.info.session.scope === BrowserViewStorageScope.Workspace || this.editor.model?.info.session.scope === BrowserViewStorageScope.Global, tooltip: '', run: () => this.history.show().catch(error => this.report(error)) },
		]);
	}

}

import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { BrowserViewEditorId } from '../../common/browserView.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { localize2 } from '../../../../../nls.js';

for (const command of [
	{ id: BrowserViewCommandId.GoBack, title: localize2({ bundle: 'ash.workbench', key: 'browser.backCommand' }, 'Browser: Go Back'), run: (model: import('../../common/browserView.js').IBrowserViewModel) => model.goBack() },
	{ id: BrowserViewCommandId.GoForward, title: localize2({ bundle: 'ash.workbench', key: 'browser.forwardCommand' }, 'Browser: Go Forward'), run: (model: import('../../common/browserView.js').IBrowserViewModel) => model.goForward() },
	{ id: BrowserViewCommandId.Reload, title: localize2({ bundle: 'ash.workbench', key: 'browser.reloadCommand' }, 'Browser: Reload'), run: (model: import('../../common/browserView.js').IBrowserViewModel) => model.reload() },
	{ id: BrowserViewCommandId.HardReload, title: localize2({ bundle: 'ash.workbench', key: 'browser.hardReloadCommand' }, 'Browser: Reload Without Cache'), run: (model: import('../../common/browserView.js').IBrowserViewModel) => model.reload(true) },
]) {
	registerAction2(class BrowserNavigationAction extends Action2 {
		constructor() {
			super({
				id: command.id, title: command.title, f1: true, precondition: ContextKeyExpr.and(ActiveEditorContext.isEqualTo(BrowserViewEditorId),
					command.id === BrowserViewCommandId.GoBack ? CONTEXT_BROWSER_CAN_GO_BACK.isEqualTo(true) : command.id === BrowserViewCommandId.GoForward ? CONTEXT_BROWSER_CAN_GO_FORWARD.isEqualTo(true) : undefined),
				keybinding: command.id === BrowserViewCommandId.GoBack || command.id === BrowserViewCommandId.GoForward
					? { primary: Keybinding.single(logicalKey(command.id === BrowserViewCommandId.GoBack ? 'ArrowLeft' : 'ArrowRight', { altKey: true })), mac: { primary: Keybinding.single(logicalKey(command.id === BrowserViewCommandId.GoBack ? '[' : ']', { metaKey: true })) }, priority: 100 }
					: { primary: Keybinding.single(logicalKey('r', { primaryKey: true, shiftKey: command.id === BrowserViewCommandId.HardReload })), secondary: [Keybinding.single(logicalKey('F5', { primaryKey: command.id === BrowserViewCommandId.HardReload }))], priority: 100 }
			});
		}
		override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
			const input = accessor.get(IEditorService).activeEditor;
			const model = input instanceof BrowserEditorInput ? input.model : undefined;
			if (!model) { return; }
			if (command.id === BrowserViewCommandId.GoBack && !model.state.canGoBack) { return; }
			if (command.id === BrowserViewCommandId.GoForward && !model.state.canGoForward) { return; }
			await command.run(model);
		}
	});
}
registerAction2(class FocusBrowserAddressAction extends Action2 {
	constructor() { super({ id: BrowserViewCommandId.FocusUrlInput, title: localize2({ bundle: 'ash.workbench', key: 'browser.focusAddressCommand' }, 'Browser: Focus Address Bar'), f1: true, precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId) }); }
	override run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): void {
		const pane = accessor.get(IEditorPart).activePane;
		if (pane?.id === BrowserViewEditorId) { pane.focus(); }
	}
});

import { Keybinding, logicalKey } from '../../../../../base/common/keybindings.js';
