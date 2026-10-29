import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import {
	Disposable,
	DisposableStore,
	MutableDisposable,
	toDisposable,
	type IDisposable,
} from '../../../base/common/lifecycle.js';
import type { IQuickAccessProvider, IQuickAccessProviderRunOptions } from '../common/quickAccess.js';
import type {
	IKeyMods,
	IQuickPick,
	IQuickPickDidAcceptEvent,
	IQuickPickItem,
	IQuickPickSeparator,
} from '../common/quickInput.js';

export enum TriggerAction {
	NO_ACTION,
	CLOSE_PICKER,
	REFRESH_PICKER,
	REMOVE_ITEM,
}

export interface IPickerQuickAccessItem extends IQuickPickItem {
	accept?(keyMods: IKeyMods, event: IQuickPickDidAcceptEvent): void;
	trigger?(buttonIndex: number, keyMods: IKeyMods): TriggerAction | Promise<TriggerAction>;
	attach?(keyMods: IKeyMods, event: IQuickPickDidAcceptEvent): void;
	/** Paging and mode selection keep the existing picker mounted. */
	readonly keepOpen?: boolean;
}

export interface IPickerQuickAccessSeparator extends IQuickPickSeparator {
	trigger?(buttonIndex: number, keyMods: IKeyMods): TriggerAction | Promise<TriggerAction>;
}

export interface IPickerQuickAccessProviderOptions<T extends IPickerQuickAccessItem> {
	readonly canAcceptInBackground?: boolean;
	readonly noResultsPick?: T | ((filter: string) => T);
	readonly shouldSkipTrimPickFilter?: boolean;
	/** Network-backed providers can coalesce typing without maintaining another request owner. */
	readonly debounce?: number;
}

export type Pick<T> = T | IQuickPickSeparator;
export type PicksWithActive<T> = { items: readonly Pick<T>[]; active?: T };
export type Picks<T> = readonly Pick<T>[] | PicksWithActive<T>;
export type FastAndSlowPicks<T> = {
	readonly picks: Picks<T>;
	readonly additionalPicks: Promise<Picks<T>>;
	readonly mergeDelay?: number;
};

/** Owns query cancellation, result publication and acceptance for existing picker providers. */
export abstract class PickerQuickAccessProvider<T extends IPickerQuickAccessItem>
	extends Disposable
	implements IQuickAccessProvider
{
	private readonly changed = this._register(new Emitter<void>());
	private current: { token: CancellationToken; publish: (picks: Picks<T>) => void } | undefined;

	constructor(
		private readonly prefix: string,
		protected readonly options: IPickerQuickAccessProviderOptions<T> = {},
	) {
		super();
	}

	protected refresh(): void {
		this.changed.fire();
	}

	/** Progressive domain searches publish through the same query identity check as promises. */
	protected updatePicks(picks: Picks<T>, token: CancellationToken): void {
		if (this.current?.token === token && !token.isCancellationRequested) this.current.publish(picks);
	}

	public provide(
		rawPicker: IQuickPick<IQuickPickItem>,
		token: CancellationToken = CancellationToken.None,
		runOptions?: IQuickAccessProviderRunOptions,
	): IDisposable {
		const picker = rawPicker as IQuickPick<T>;
		const lifetime = new DisposableStore();
		const request = lifetime.add(new MutableDisposable<DisposableStore>());
		picker.filterValue = () => '';
		picker.sortByLabel = false;
		picker.canAcceptInBackground = !!this.options.canAcceptInBackground;
		const update = async (): Promise<void> => {
			request.clear();
			if (token.isCancellationRequested) return;
			const resources = new DisposableStore();
			const query = new CancellationTokenSource(token);
			resources.add(toDisposable(() => query.dispose(true)));
			request.value = resources;
			const raw = picker.value.slice(this.prefix.length);
			const filter = this.options.shouldSkipTrimPickFilter ? raw : raw.trim();
			const publish = (picks: Picks<T>): void => {
				if (query.token.isCancellationRequested || request.value !== resources) return;
				const result: PicksWithActive<T> = Array.isArray(picks)
					? { items: picks }
					: (picks as PicksWithActive<T>);
				let items = result.items;
				if (!items.some(item => !('type' in item)) && this.options.noResultsPick) {
					items = [
						typeof this.options.noResultsPick === 'function'
							? this.options.noResultsPick(filter)
							: this.options.noResultsPick,
					];
				}
				picker.items = items;
				if (result.active) picker.activeItems = [result.active];
			};
			this.current = { token: query.token, publish };
			try {
				const candidate = this._getPicks(filter, resources, query.token, runOptions);
				if (isPromise(candidate)) picker.busy = true;
				const result = isPromise(candidate) ? await candidate : candidate;
				if (query.token.isCancellationRequested || !result) return;
				if ('additionalPicks' in result) {
					picker.busy = true;
					const merge = (additional: Picks<T>): void => {
						const first: PicksWithActive<T> = Array.isArray(result.picks)
							? { items: result.picks }
							: (result.picks as PicksWithActive<T>);
						const second: PicksWithActive<T> = Array.isArray(additional)
							? { items: additional }
							: (additional as PicksWithActive<T>);
						publish({ items: [...first.items, ...second.items], active: second.active ?? first.active });
					};
					const delayed = resources.add(
						new RunOnceScheduler(() => publish(result.picks), result.mergeDelay ?? 0),
					);
					if (result.mergeDelay) delayed.schedule();
					else publish(result.picks);
					const additional = await result.additionalPicks;
					delayed.cancel();
					merge(additional);
				} else publish(result);
			} catch (error) {
				if (!query.token.isCancellationRequested) onUnexpectedError(error);
			} finally {
				if (!query.token.isCancellationRequested && request.value === resources) picker.busy = false;
			}
		};
		const scheduler = lifetime.add(
			new RunOnceScheduler(() => {
				void update();
			}, this.options.debounce ?? 0),
		);
		lifetime.add(
			picker.onDidChangeValue(() => {
				request.clear();
				if (this.options.debounce) {
					picker.items = [];
					picker.busy = true;
					scheduler.schedule();
				} else void update();
			}),
		);
		lifetime.add(
			this.changed.event(() => {
				scheduler.cancel();
				void update();
			}),
		);
		lifetime.add(
			picker.onDidAccept(event => {
				const item = picker.selectedItems[0];
				if (!item) return;
				const mods = picker.keyMods ?? { ctrlCmd: false, alt: false, shift: false };
				if (runOptions?.handleAccept) {
					runOptions.handleAccept(item, event.inBackground);
					return;
				}
				if (item.attach && (mods.ctrlCmd || mods.alt)) {
					item.attach(mods, event);
					return;
				}
				if (!event.inBackground && !item.keepOpen) picker.hide();
				item.accept?.(mods, event);
			}),
		);
		lifetime.add(
			picker.onDidTriggerItemButton(({ item, button }) => {
				const index = item.buttons?.indexOf(button) ?? -1;
				if (index < 0 || !item.trigger) return;
				void Promise.resolve(
					item.trigger(index, picker.keyMods ?? { ctrlCmd: false, alt: false, shift: false }),
				)
					.then(action => {
						if (token.isCancellationRequested) return;
						if (action === TriggerAction.CLOSE_PICKER) picker.hide();
						else if (action === TriggerAction.REFRESH_PICKER) {
							this.refresh();
							picker.show();
						} else if (action === TriggerAction.REMOVE_ITEM)
							picker.items = picker.items.filter(candidate => candidate !== item);
					})
					.catch(error => {
						if (!token.isCancellationRequested) onUnexpectedError(error);
					});
			}),
		);
		lifetime.add(
			token.onCancellationRequested(() => {
				scheduler.cancel();
				request.clear();
				this.current = undefined;
				picker.busy = false;
			}),
		);
		lifetime.add(
			toDisposable(() => {
				this.current = undefined;
				picker.busy = false;
			}),
		);
		void update();
		return lifetime;
	}

	protected abstract _getPicks(
		filter: string,
		disposables: DisposableStore,
		token: CancellationToken,
		runOptions?: IQuickAccessProviderRunOptions,
	): Picks<T> | Promise<Picks<T> | FastAndSlowPicks<T>> | FastAndSlowPicks<T> | null;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return !!value && typeof (value as Promise<T>).then === 'function';
}
