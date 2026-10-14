import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import type { IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { BrowserUrlBarWidget, type IBrowserUrlBarHost } from '../widgets/browserUrlBarWidget.js';
import { BrowserSearchFeatures } from './browserSearchFeatures.js';

/** Retains navigation action identities so title changes preserve keyboard focus. */
export class BrowserNavigationFeatures extends Disposable {
	public readonly address: BrowserUrlBarWidget;
	private readonly toolbar: WorkbenchToolBar;
	private readonly search: BrowserSearchFeatures;
	private actions: readonly IAction[] = [];
	constructor(private readonly host: IBrowserUrlBarHost, container: HTMLElement, private readonly report: (error: unknown) => void,
		@IContextMenuService menus: IContextMenuService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const navigation = container.ownerDocument.createElement('div');
		navigation.className = 'ash-browser-navigation';
		container.append(navigation);
		this.toolbar = this._register(new WorkbenchToolBar(navigation, menus, { ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.navigationToolbar' }, 'Browser navigation') }));
		this.address = this._register(instantiation.createInstance(BrowserUrlBarWidget, host, container, (value: string) => { this.address.inputElement.value = value; return this.navigate(); }, report));
		this.search = instantiation.createInstance(BrowserSearchFeatures);
		this._register(addDisposableListener<KeyboardEvent>(this.address.inputElement, 'keydown', event => {
			if (event.key === 'Enter') { event.preventDefault(); void this.navigate().catch(report); }
		}));
		this.update();
	}
	public async navigate(): Promise<void> {
		const model = this.host.input?.model;
		const text = this.address.value;
		const url = this.search.resolve(text);
		if (!model || !url) { return; }
		const focused = this.address.inputElement.ownerDocument.activeElement;
		await model.loadURL(url);
		if (!this.isDisposed && this.host.input?.model === model && this.address.value === text && this.address.inputElement.ownerDocument.activeElement === focused) { this.host.ensureBrowserFocus(); }
	}
	public update(state?: IBrowserViewState): void {
		this.address.refreshUrl();
		const back = localize({ bundle: 'ash.workbench', key: 'browser.back' }, 'Back');
		const forward = localize({ bundle: 'ash.workbench', key: 'browser.forward' }, 'Forward');
		const reload = state?.loading ? localize({ bundle: 'ash.workbench', key: 'browser.stop' }, 'Stop') : localize({ bundle: 'ash.workbench', key: 'browser.reload' }, 'Reload');
		const actions: readonly IAction[] = [
			{ id: 'browser.back', label: back, tooltip: back, icon: Lxicon.arrowLeft, enabled: state?.canGoBack === true, run: () => this.host.input?.model?.goBack().catch(this.report) },
			{ id: 'browser.forward', label: forward, tooltip: forward, icon: Lxicon.arrowRight, enabled: state?.canGoForward === true, run: () => this.host.input?.model?.goForward().catch(this.report) },
			{
				id: 'browser.reload', label: reload, tooltip: reload, icon: state?.loading ? Lxicon.close : Lxicon.refresh, enabled: !!state, run: () => {
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
	public focusUrlInput(): void { this.address.focusUrlInput(); }
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
				id: command.id, title: command.title, f1: true, precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
				keybinding: command.id === BrowserViewCommandId.GoBack || command.id === BrowserViewCommandId.GoForward
					? { primary: Keybinding.single(logicalKey(command.id === BrowserViewCommandId.GoBack ? 'ArrowLeft' : 'ArrowRight', { altKey: true })), mac: { primary: Keybinding.single(logicalKey(command.id === BrowserViewCommandId.GoBack ? '[' : ']', { metaKey: true })) }, priority: 100 }
					: { primary: Keybinding.single(logicalKey('r', { primaryKey: true, shiftKey: command.id === BrowserViewCommandId.HardReload })), secondary: [Keybinding.single(logicalKey('F5', { primaryKey: command.id === BrowserViewCommandId.HardReload }))], priority: 100 }
			});
		}
		override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
			const input = accessor.get(IEditorService).activeEditor;
			if (input instanceof BrowserEditorInput && input.model) { await command.run(input.model); }
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
