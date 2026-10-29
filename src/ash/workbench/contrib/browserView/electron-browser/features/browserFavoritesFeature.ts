import { BrowserNavigationFeatures } from './browserNavigationFeatures.js';
import {
	Disposable,
	DisposableStore,
	MutableDisposable,
	toDisposable,
	type IDisposable,
} from '../../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { isRecord } from '../../../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { normalizeBrowserViewUrl } from '../../../../../platform/browserView/common/browserView.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import { localize } from '../../../../../nls.js';

const key = 'browserView.favorites';
interface Favorite {
	readonly url: string;
	readonly title: string;
}

/** Explicit user bookmarks are profile preferences; isolated Agent URLs never enter this collection. */
export class BrowserFavoritesFeature extends Disposable {
	private model: IBrowserViewModel | undefined;
	private readonly pendingPicker = this._register(new MutableDisposable<IDisposable>());
	constructor(
		private readonly changed: () => void,
		private readonly report: (error: unknown) => void,
		@IStorageService private readonly storage: IStorageService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === key) {
					changed();
				}
			}),
		);
	}
	public setModel(model: IBrowserViewModel | undefined): void {
		this.pendingPicker.clear();
		this.model = model;
	}
	public readonly urlSuggestionProviders: readonly import('../browserEditor.js').IBrowserUrlSuggestionProvider[] = [
		{
			get label() {
				return localize({ bundle: 'ash.workbench', key: 'browser.favorites' }, 'Favorites');
			},
			order: 0,
			getSuggestions: async ({ text }, token) =>
				token.isCancellationRequested
					? []
					: this.read()
							.filter(entry => (entry.title + ' ' + entry.url).toLowerCase().includes(text.toLowerCase()))
							.slice(0, 50)
							.map(entry => ({
								id: 'favorite:' + entry.url,
								label: entry.title || entry.url,
								description: entry.url,
								apply: input => input.model?.loadURL(entry.url),
							})),
		},
	];
	private read(): readonly Favorite[] {
		const raw = this.storage.get(key, StorageScope.PROFILE);
		if (!raw) {
			return [];
		}
		const entries: unknown = JSON.parse(raw);
		if (!Array.isArray(entries) || entries.length > 1000) {
			throw new TypeError('Invalid browser favorites');
		}
		return entries.map(entry => {
			if (!isRecord(entry) || typeof entry.title !== 'string' || entry.title.length > 4096) {
				throw new TypeError('Invalid browser favorite');
			}
			return { url: normalizeBrowserViewUrl(entry.url), title: entry.title };
		});
	}
	public getActions(): readonly IAction[] {
		return [
			{
				id: 'browser.favorite',
				label: localize({ bundle: 'ash.workbench', key: 'browser.favoriteToggle' }, 'Add or remove favorite'),
				tooltip: '',
				enabled: this.model?.info.owner.type === 'user' && this.model.state.url !== 'about:blank',
				run: () => this.toggle(),
			},
			{
				id: 'browser.favorites',
				label: localize({ bundle: 'ash.workbench', key: 'browser.favorites' }, 'Favorites'),
				tooltip: '',
				enabled: !!this.model,
				run: () => this.show().catch(this.report),
			},
		];
	}
	public toggle(): void {
		const model = this.model;
		if (!model || model.info.owner.type !== 'user' || model.state.url === 'about:blank') {
			return;
		}
		const values = this.read();
		const retained = values.filter(entry => entry.url !== model.state.url);
		if (retained.length === values.length) {
			retained.push({ url: model.state.url, title: model.state.title });
		}
		this.storage.store(key, JSON.stringify(retained.slice(-1000)), StorageScope.PROFILE, StorageTarget.USER);
	}
	private async show(): Promise<void> {
		const model = this.model;
		if (!model) {
			return;
		}
		using picker = this.quickInput.createQuickPick<IQuickPickItem & { url: string }>();
		using listeners = new DisposableStore();
		picker.ariaLabel = localize({ bundle: 'ash.workbench', key: 'browser.favorites' }, 'Favorites');
		picker.items = this.read().map(entry => ({
			label: entry.title || entry.url,
			description: entry.url,
			url: entry.url,
		}));
		let url: string | undefined;
		using pending = toDisposable(() => picker.hide());
		await new Promise<void>(resolve => {
			listeners.add(picker.onDidHide(resolve));
			listeners.add(
				picker.onDidAccept(() => {
					url = picker.selectedItems[0]?.url;
					picker.hide();
				}),
			);
			this.pendingPicker.value = pending;
			picker.show();
		});
		if (this.pendingPicker.value === pending) {
			this.pendingPicker.clear();
		}
		if (url && this.model === model && !this.isDisposed) {
			await model.loadURL(url);
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
				id: BrowserViewCommandId.ToggleFavorite,
				title: localize2(
					{ bundle: 'ash.workbench', key: 'browser.favoriteCommand' },
					'Browser: Toggle Favorite',
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
				await (pane as BrowserEditor).getContribution(BrowserNavigationFeatures)?.favorites.toggle();
			}
		}
	},
);
