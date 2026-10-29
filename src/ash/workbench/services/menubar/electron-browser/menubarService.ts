import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { invoke, subscribe } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { NATIVE_MENUBAR_SELECT_CHANNEL, NATIVE_MENUBAR_UPDATE_CHANNEL, type INativeMenubarData, type INativeMenubarSelection } from '../../../../platform/menubar/common/nativeMenubar.js';
import { IMenubarService } from '../../../../platform/menubar/electron-browser/menubar.js';

class MenubarService extends Disposable implements IMenubarService {
	declare readonly _serviceBrand: undefined;
	private readonly selections = this._register(new Emitter<INativeMenubarSelection>());
	readonly onDidSelect = this.selections.event;

	constructor() {
		super();
		const subscription = subscribe<unknown>(NATIVE_MENUBAR_SELECT_CHANNEL, value => {
			if (!isRecord(value)) {
				return;
			}
			const { revision, id } = value;
			if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || typeof id !== 'string' || id.length === 0 || id.length > 128) {
				return;
			}
			this.selections.fire({ revision, id });
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	updateMenubar(menuData: INativeMenubarData): Promise<void> {
		this.assertNotDisposed();
		return invoke<void>(NATIVE_MENUBAR_UPDATE_CHANNEL, menuData);
	}
}

registerSingleton(IMenubarService, MenubarService, InstantiationType.Delayed);
