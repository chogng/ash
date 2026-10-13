import { Disposable, DisposableStore, MutableDisposable, isDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../common/quickInput.js';
import { QuickAccessRegistry, type IQuickAccessController, type IQuickAccessOptions, type IQuickAccessProviderDescriptor } from '../common/quickAccess.js';

/** Keeps one picker mounted while its search provider changes with the input prefix. */
export class QuickAccessController extends Disposable implements IQuickAccessController {
	private readonly visibilityChanged = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this.visibilityChanged.event;
	private active: IQuickPick<IQuickPickItem> | undefined;
	private readonly session = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	show(value = '', options?: IQuickAccessOptions): void {
		if (this.active && !options) {
			this.active.value = value;
			this.active.show();
			this.active.valueSelection = { start: QuickAccessRegistry.get(value)?.prefix.length ?? 0, end: value.length };
			return;
		}
		this.active?.hide();
		const session = new DisposableStore();
		const picker = session.add(this.quickInputService.createQuickPick<IQuickPickItem>());
		picker.anchor = options?.anchor;
		picker.anchorPosition = options?.anchorPosition;
		const provider = session.add(new MutableDisposable());
		let descriptor: IQuickAccessProviderDescriptor | undefined;
		const updateNavigation = (): void => {
			if (options) return;
			const modes = QuickAccessRegistry.all().filter(mode => mode.tabLabel !== undefined)
				.sort((left, right) => (left.tabOrder ?? Number.MAX_VALUE) - (right.tabOrder ?? Number.MAX_VALUE));
			if (modes.length < 2) return;
			picker.navigation = {
				items: modes.map(mode => ({ id: `quickAccess:${mode.prefix}`, label: mode.tabLabel! })),
				selectedId: modes.some(mode => mode === descriptor) ? `quickAccess:${descriptor!.prefix}` : undefined,
				onSelect: id => {
					const prefix = modes.find(mode => `quickAccess:${mode.prefix}` === id)!.prefix;
					const query = picker.value.slice(descriptor?.prefix.length ?? 0);
					picker.value = prefix + query;
					picker.show();
					picker.valueSelection = { start: prefix.length, end: picker.value.length };
				},
			};
		};
		const activate = (input: string): void => {
			const match = QuickAccessRegistry.get(input);
			const next = match && (!options?.enabledProviderPrefixes || options.enabledProviderPrefixes.includes(match.prefix)) ? match : QuickAccessRegistry.get('');
			if (next === descriptor) return;
			provider.clear();
			descriptor = next;
			updateNavigation();
			picker.items = [];
			picker.sortByLabel = true;
			if (!next) return;
			picker.placeholder = options?.placeholder ?? next.placeholder;
			picker.ariaLabel = picker.placeholder;
			picker.filterValue = value => value.slice(next.prefix.length);
			const lifetime = new DisposableStore();
			const cancellation = new CancellationTokenSource();
			lifetime.add(toDisposable(() => cancellation.dispose(true)));
			try {
				const instance = this.instantiationService.createInstance(next.ctor);
				if (isDisposable(instance)) lifetime.add(instance);
				lifetime.add(instance.provide(picker, cancellation.token, options?.providerOptions));
				provider.value = lifetime;
			} catch (error) {
				lifetime.dispose();
				throw error;
			}
		};
		session.add(picker.onDidChangeValue(activate));
		session.add(picker.onDidHide(() => {
			this.active = undefined;
			// A hide listener can open a new session without prematurely disposing this picker.
			if (this.session.value === session) this.session.clearAndLeak();
			// Accepted commands can dispose the captured editor before deferred picker cleanup.
			provider.clear();
			this.visibilityChanged.fire(false);
			// Preserve delivery to hide listeners while releasing only this session afterward.
			queueMicrotask(() => session.dispose());
		}));
		this.session.value = session;
		this.active = picker;
		picker.value = value;
		activate(value);
		picker.show();
		picker.valueSelection = { start: descriptor?.prefix.length ?? 0, end: value.length };
		this.visibilityChanged.fire(true);
	}
}
