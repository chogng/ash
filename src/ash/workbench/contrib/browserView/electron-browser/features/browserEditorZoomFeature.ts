import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { IBrowserViewService, BrowserViewStorageScope, browserZoomFactors } from '../../../../../platform/browserView/common/browserView.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IBrowserZoomService, MATCH_WINDOW_ZOOM_LABEL } from '../../common/browserZoomService.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import { localize, localize2 } from '../../../../../nls.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { BrowserViewEditorId } from '../../common/browserView.js';
import { Keybinding, logicalKey } from '../../../../../base/common/keybindings.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';

function zoomHost(model: IBrowserViewModel): string | undefined {
	const url = new URL(model.state.url);
	return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : undefined;
}

async function setZoom(model: IBrowserViewModel, index: number, zoom: IBrowserZoomService, pages: IBrowserViewService): Promise<void> {
	const host = zoomHost(model);
	if (host) {
		const memory = model.info.session.scope === BrowserViewStorageScope.Agent || model.info.session.scope === BrowserViewStorageScope.Ephemeral;
		zoom.setHostZoomIndex(host, index, memory);
	} else { await pages.setBrowserZoomIndex(model.id, index); }
}

for (const command of [
	{ id: 'workbench.action.browser.zoomIn', title: localize2({ bundle: 'ash.workbench', key: 'browser.zoomIn' }, 'Browser: Zoom In'), key: '=', step: 1 },
	{ id: 'workbench.action.browser.zoomOut', title: localize2({ bundle: 'ash.workbench', key: 'browser.zoomOut' }, 'Browser: Zoom Out'), key: '-', step: -1 },
	{ id: 'workbench.action.browser.resetZoom', title: localize2({ bundle: 'ash.workbench', key: 'browser.resetZoom' }, 'Browser: Reset Zoom'), key: '0', step: 0 },
]) {
	registerAction2(class BrowserZoomAction extends Action2 {
		constructor() {
			super({
				id: command.id, title: command.title, f1: true,
				precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
				keybinding: { primary: Keybinding.single(logicalKey(command.key, { primaryKey: true })), priority: 100 },
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const input = accessor.get(IEditorService).activeEditor;
			if (!(input instanceof BrowserEditorInput) || !input.model) { return; }
			const zoom = accessor.get(IBrowserZoomService);
			const index = command.step === 0 ? zoom.getEffectiveZoomIndex(undefined, false)
				: Math.max(0, Math.min(browserZoomFactors.length - 1, (input.model.state.browserZoomIndex ?? zoom.getEffectiveZoomIndex(undefined, false)) + command.step));
			await setZoom(input.model, index, zoom, accessor.get(IBrowserViewService));
		}
	});
}

class WindowZoomSynchronizer extends Disposable {
	private readonly inputs = this._register(new DisposableMap<string, DisposableStore>());
	constructor(@INativeHostService host: INativeHostApi, @IBrowserZoomService zoom: IBrowserZoomService,
		@IBrowserViewWorkbenchService views: IBrowserViewWorkbenchService,
		@IBrowserViewService pages: IBrowserViewService,
		@IEditorService editors: IEditorService,
	) {
		super();
		let changed = false;
		const subscription = host.onDidChangeZoomLevel(level => {
			changed = true;
			zoom.notifyWindowZoomChanged(Math.pow(1.2, level));
		});
		this._register(toDisposable(() => subscription.dispose()));
		void host.getZoomLevel().then(level => {
			if (!this.isDisposed && !changed) { zoom.notifyWindowZoomChanged(Math.pow(1.2, level)); }
		}).catch(onUnexpectedError);
		const refresh = (): void => {
			if (this.isDisposed) { return; }
			const known = views.getKnownBrowserViews();
			for (const id of this.inputs.keys()) { if (!known.has(id)) { this.inputs.deleteAndDispose(id); } }
			for (const [id, input] of known) {
				if (this.inputs.has(id)) { continue; }
				const lifetime = new DisposableStore();
				const binding = lifetime.add(new DisposableStore());
				const attach = (): void => {
					binding.clear();
					const model = input.model;
					if (!model) { return; }
					const apply = (): void => {
						try {
							const memory = model.info.session.scope === BrowserViewStorageScope.Agent || model.info.session.scope === BrowserViewStorageScope.Ephemeral;
							const index = zoom.getEffectiveZoomIndex(zoomHost(model), memory);
							if (model.state.browserZoomIndex !== index) { void pages.setBrowserZoomIndex(id, index).catch(onUnexpectedError); }
						} catch (error) { onUnexpectedError(error); }
					};
					let url = model.state.url;
					let index = model.state.browserZoomIndex;
					binding.add(model.onDidChangeState(state => {
						if (index !== undefined && index !== state.browserZoomIndex && state.browserZoomIndex !== undefined && editors.activeEditor === input) {
							status(localize({ bundle: 'ash.workbench', key: 'browser.zoomApplied' }, 'Page zoom: {0}%', Math.round(browserZoomFactors[state.browserZoomIndex]! * 100)));
						}
						index = state.browserZoomIndex;
						if (url === state.url) { return; }
						url = state.url;
						apply();
					}));
					binding.add(model.onWillDispose(() => binding.clear()));
					binding.add(zoom.onDidChangeZoom(apply));
					apply();
				};
				this.inputs.set(id, lifetime);
				lifetime.add(input.onDidResolveModel(attach));
				attach();
			}
		};
		this._register(views.onDidChangeBrowserViews(refresh));
		void views.initialize().then(refresh).catch(onUnexpectedError);
	}
}

registerWorkbenchContribution('workbench.contrib.browserView.windowZoomSynchronizer', WorkbenchPhase.BlockRestore,
	services => services.get(IInstantiationService).createInstance(WindowZoomSynchronizer));

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'workbench.browser.pageZoom', defaultValue: MATCH_WINDOW_ZOOM_LABEL, scope: ConfigurationScope.MACHINE,
	parse: value => {
		if (typeof value !== 'string' || (value !== MATCH_WINDOW_ZOOM_LABEL && !browserZoomFactors.some(factor => `${Math.round(factor * 100)}%` === value))) { throw new TypeError('Invalid browser page zoom'); }
		return value;
	},
	setting: {
		valueType: 'select',
		title: localize({ bundle: 'ash.workbench', key: 'browser.defaultZoom' }, 'Default browser page zoom'),
		description: localize({ bundle: 'ash.workbench', key: 'browser.defaultZoomDescription' }, 'Choose the default zoom for websites, or follow the application window zoom.'),
		options: [{ value: MATCH_WINDOW_ZOOM_LABEL, label: localize({ bundle: 'ash.workbench', key: 'browser.matchWindow' }, 'Match Window') },
		...browserZoomFactors.map(factor => ({ value: `${Math.round(factor * 100)}%`, label: `${Math.round(factor * 100)}%` }))],
	},
});

/** Applies shared host preferences to the attached Main page, including sibling tabs. */
export class BrowserEditorZoomSupport extends Disposable {
	private model: IBrowserViewModel | undefined;
	private readonly pendingPicker = this._register(new MutableDisposable<IDisposable>());
	constructor(private readonly report: (error: unknown) => void,
		@IBrowserViewService private readonly pages: IBrowserViewService,
		@IBrowserZoomService private readonly zoom: IBrowserZoomService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) { super(); }
	public setModel(model: IBrowserViewModel | undefined): void {
		this.pendingPicker.clear();
		this.model = model;
	}
	public async show(): Promise<void> {
		const model = this.model;
		if (!model) { return; }
		using picker = this.quickInput.createQuickPick<IQuickPickItem & { index: number; }>();
		using listeners = new DisposableStore();
		picker.ariaLabel = localize({ bundle: 'ash.workbench', key: 'browser.zoom' }, 'Page zoom');
		picker.items = browserZoomFactors.map((factor, index) => ({ label: localize({ bundle: 'ash.workbench', key: 'browser.zoomPercent' }, '{0}%', Math.round(factor * 100)), index }));
		let selected: number | undefined;
		using pending = toDisposable(() => picker.hide());
		await new Promise<void>(resolve => {
			listeners.add(picker.onDidHide(resolve));
			listeners.add(picker.onDidAccept(() => { selected = picker.selectedItems[0]?.index; picker.hide(); }));
			this.pendingPicker.value = pending;
			picker.show();
		});
		if (this.pendingPicker.value === pending) { this.pendingPicker.clear(); }
		if (selected === undefined || this.isDisposed || this.model !== model) { return; }
		await setZoom(model, selected, this.zoom, this.pages);
	}
}
