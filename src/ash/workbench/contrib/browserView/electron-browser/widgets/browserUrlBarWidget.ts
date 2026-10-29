import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import type { IBrowserUrlSuggestionProvider } from '../browserEditor.js';
import type { BrowserEditorInput } from '../../common/browserEditorInput.js';

export type IUrlPickerItem = IQuickPickItem & {
	readonly id?: string;
	apply?(input: BrowserEditorInput): void | Promise<void>;
};

export interface IBrowserUrlBarHost {
	readonly input: BrowserEditorInput | undefined;
	ensureBrowserFocus(): void;
	getPrimaryActions?(text: string): readonly IUrlPickerItem[];
	getPlaceholder?(): string;
}

/** Owns address editing; updates from Chromium do not overwrite an address the user is editing. */
export class BrowserUrlBarWidget extends Disposable {
	public readonly element: HTMLElement;
	public readonly inputElement: HTMLInputElement;
	private readonly input: InputBox;
	private readonly picker = this._register(new MutableDisposable<DisposableStore>());
	private refreshPicker: (() => void) | undefined;
	private providers: readonly IBrowserUrlSuggestionProvider[] = [];
	constructor(
		private readonly host: IBrowserUrlBarHost,
		parent: HTMLElement,
		private readonly navigate: (text: string) => Promise<void>,
		private readonly report: (error: unknown) => void,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
		this.input = this._register(
			new InputBox(parent, {
				inputBoxStyles: defaultInputBoxStyles,
				presentation: 'compact',
				enabled: false,
				ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.address' }, 'Browser address'),
			}),
		);
		this.element = this.input.element;
		this.element.classList.add('ash-browser-address');
		this.inputElement = this.input.inputElement;
		this.inputElement.type = 'url';
		this._register(
			addDisposableListener<KeyboardEvent>(this.inputElement, 'keydown', event => {
				if (event.isComposing) {
					return;
				}
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					this.openUrlPicker();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					this.inputElement.value = this.host.input?.model?.state.url ?? '';
					this.host.ensureBrowserFocus();
				}
			}),
		);
	}
	public mountContributions(contributions: readonly { readonly urlSuggestionProviders: readonly IBrowserUrlSuggestionProvider[] }[]): void {
		this.picker.clear();
		this.providers = contributions.flatMap(contribution => contribution.urlSuggestionProviders).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}
	public openUrlPicker(): void {
		const input = this.host.input;
		if (!input?.model) {
			return;
		}
		const model = input.model;
		const resources = new DisposableStore();
		this.picker.value = resources;
		const picker = resources.add(this.quickInput.createQuickPick<IUrlPickerItem>());
		const cancellation = resources.add(new MutableDisposable<import('../../../../../base/common/lifecycle.js').IDisposable>());
		let revision = 0;
		let accepted = false;
		let escape = false;
		picker.ariaLabel = localize({ bundle: 'ash.workbench', key: 'browser.address' }, 'Browser address');
		picker.placeholder = this.host.getPlaceholder?.() ?? '';
		picker.value = this.value;
		picker.valueSelection = { start: 0, end: picker.value.length };
		picker.sortByLabel = false;
		picker.anchor = this.element;
		const load = (typed = false): void => {
			const active = typed ? undefined : picker.activeItems[0]?.id;
			const request = ++revision;
			const source = new CancellationTokenSource();
			cancellation.value = toDisposable(() => source.dispose(true));
			const text = picker.value;
			const fallback: IUrlPickerItem = {
				id: 'address',
				label: localize({ bundle: 'ash.workbench', key: 'browser.goToAddress' }, 'Go to {0}', text),
				alwaysShow: true,
			};
			const primary = (this.host.getPrimaryActions?.(text.trim()) ?? [fallback]).map(item => ({
				...item,
				alwaysShow: true,
			}));
			picker.placeholder = this.host.getPlaceholder?.() ?? '';
			picker.items = primary;
			picker.activeItems = primary.filter(item => item.id === active).slice(0, 1);
			if (!picker.activeItems.length) {
				picker.activeItems = primary.slice(0, 1);
			}
			void Promise.allSettled(this.providers.map(provider => provider.getSuggestions({ text, input }, source.token))).then(results => {
				if (source.token.isCancellationRequested || request !== revision || this.picker.value !== resources || this.host.input !== input || input.model !== model) {
					return;
				}
				const items = results.flatMap((result, index) =>
					result.status === 'fulfilled' && result.value.length ? [{ type: 'separator' as const, label: this.providers[index]!.label }, ...filterQuickPickItems(result.value, text)] : [],
				);
				picker.items = [...primary, ...items];
				const selectedId = picker.activeItems[0]?.id;
				const retained = selectedId ? (picker.items.filter(item => !('type' in item) && item.id === selectedId) as IUrlPickerItem[]) : [];
				picker.activeItems = retained.length ? retained : primary.slice(0, 1);
			});
		};
		this.refreshPicker = () => load();
		resources.add(
			toDisposable(() => {
				if (this.picker.value === resources || !this.picker.value) {
					this.refreshPicker = undefined;
				}
			}),
		);
		// Window capture observes dismissal before Workbench's document-level keybinding handler consumes Escape.
		resources.add(
			addDisposableListener<KeyboardEvent>(
				this.inputElement.ownerDocument.defaultView!,
				'keydown',
				event => {
					if (this.picker.value === resources && !event.isComposing && event.key === 'Escape') {
						escape = true;
					}
				},
				true,
			),
		);
		resources.add(picker.onDidChangeValue(() => load(true)));
		for (const provider of this.providers) {
			if (provider.onDidChange) {
				resources.add(provider.onDidChange(() => load()));
			}
		}
		resources.add(
			picker.onDidAccept(() => {
				accepted = true;
				const selected = picker.selectedItems[0] ?? picker.activeItems[0];
				const text = picker.value;
				picker.hide();
				const focused = this.inputElement.ownerDocument.activeElement;
				const address = this.value;
				void Promise.resolve()
					.then(async () => {
						if (this.isDisposed || this.host.input !== input || input.model !== model || input.isDisposed) {
							return;
						}
						if (selected?.apply) {
							await selected.apply(input);
						} else {
							await this.navigate(text);
						}
						if (!this.isDisposed && this.host.input === input && input.model === model && this.inputElement.ownerDocument.activeElement === focused && this.value === address) {
							this.host.ensureBrowserFocus();
						}
					})
					.catch(error => {
						if (!this.isDisposed && this.host.input === input && input.model === model) {
							this.report(error);
						}
					});
			}),
		);
		resources.add(
			picker.onDidHide(() => {
				if (!accepted && this.picker.value === resources && this.host.input === input) {
					this.inputElement.value = model.state.url;
					if (escape) {
						this.host.ensureBrowserFocus();
					}
				}
				if (this.picker.value === resources) {
					this.picker.clear();
				}
			}),
		);
		resources.add(toDisposable(() => picker.hide()));
		load();
		picker.show();
	}
	public get value(): string {
		return this.inputElement.value;
	}
	public refreshUrl(): void {
		this.input.enabled = !!this.host.input?.model;
		this.inputElement.placeholder = this.host.getPlaceholder?.() ?? '';
		this.refreshPicker?.();
		const url = this.host.input?.model?.state.url ?? '';
		this.previewUrl(url);
	}
	public previewUrl(url: string): void {
		if (!this.picker.value && this.inputElement.ownerDocument.activeElement !== this.inputElement) {
			this.inputElement.value = url;
		}
	}
	public focusUrlInput(): void {
		this.inputElement.focus();
		this.inputElement.select();
	}
	public clear(): void {
		this.picker.clear();
		this.input.enabled = false;
		this.inputElement.value = '';
	}
}
