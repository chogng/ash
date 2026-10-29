import { BrowserNavigationFeatures } from './browserNavigationFeatures.js';
import {
	Disposable,
	DisposableStore,
	MutableDisposable,
	toDisposable,
	type IDisposable,
} from '../../../../../base/common/lifecycle.js';
import {
	IBrowserViewService,
	type IBrowserDeviceProfile,
} from '../../../../../platform/browserView/common/browserView.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import { localize } from '../../../../../nls.js';

/** Device selection changes Chromium metrics through Main, leaving compositor bounds with the page host. */
export class BrowserEditorEmulationSupport extends Disposable {
	private model: IBrowserViewModel | undefined;
	private readonly pendingPicker = this._register(new MutableDisposable<IDisposable>());
	constructor(
		@IBrowserViewService private readonly pages: IBrowserViewService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
	}
	public setModel(model: IBrowserViewModel | undefined): void {
		this.pendingPicker.clear();
		this.model = model;
	}
	public async show(): Promise<void> {
		const model = this.model;
		if (!model) {
			return;
		}
		using picker = this.quickInput.createQuickPick<IQuickPickItem & { device?: IBrowserDeviceProfile }>();
		using listeners = new DisposableStore();
		picker.ariaLabel = localize({ bundle: 'ash.workbench', key: 'browser.emulation' }, 'Device emulation');
		picker.items = [
			{ label: localize({ bundle: 'ash.workbench', key: 'browser.emulationOff' }, 'Disable emulation') },
			{
				label: localize({ bundle: 'ash.workbench', key: 'browser.emulationPhone' }, 'Phone (390 × 844)'),
				device: { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
			},
			{
				label: localize({ bundle: 'ash.workbench', key: 'browser.emulationTablet' }, 'Tablet (768 × 1024)'),
				device: { width: 768, height: 1024, mobile: true, deviceScaleFactor: 1 },
			},
			{
				label: localize({ bundle: 'ash.workbench', key: 'browser.emulationDesktop' }, 'Desktop (1280 × 720)'),
				device: { width: 1280, height: 720, mobile: false, deviceScaleFactor: 1 },
			},
		];
		let selection: (IQuickPickItem & { device?: IBrowserDeviceProfile }) | undefined;
		using pending = toDisposable(() => picker.hide());
		await new Promise<void>(resolve => {
			listeners.add(picker.onDidHide(resolve));
			listeners.add(
				picker.onDidAccept(() => {
					selection = picker.selectedItems[0];
					picker.hide();
				}),
			);
			this.pendingPicker.value = pending;
			picker.show();
		});
		if (this.pendingPicker.value === pending) {
			this.pendingPicker.clear();
		}
		if (selection && !this.isDisposed && this.model === model) {
			await this.pages.setDeviceEmulation(model.id, selection.device);
		}
	}
}

import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserViewEditorId } from '../../common/browserView.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { localize2 } from '../../../../../nls.js';
import type { BrowserEditor } from '../browserEditor.js';
registerAction2(
	class BrowserFeatureAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.browser.toggleDeviceEmulation',
				title: localize2(
					{ bundle: 'ash.workbench', key: 'browser.emulationCommand' },
					'Browser: Device Emulation',
				),
				f1: true,
				precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
			});
		}
		override async run(
			accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor,
		): Promise<void> {
			const pane = accessor.get(IEditorPart).activePane;
			if (pane?.id === BrowserViewEditorId) {
				await (pane as BrowserEditor).getContribution(BrowserNavigationFeatures)?.emulation.show();
			}
		}
	},
);
