import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
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
		const provider = session.add(new MutableDisposable());
		let descriptor: IQuickAccessProviderDescriptor | undefined;
		const activate = (input: string): void => {
			const match = QuickAccessRegistry.get(input);
			const next = match && (!options?.enabledProviderPrefixes || options.enabledProviderPrefixes.includes(match.prefix)) ? match : QuickAccessRegistry.get('');
			if (next === descriptor) return;
			provider.clear();
			descriptor = next;
			picker.items = [];
			if (!next) return;
			picker.placeholder = options?.placeholder ?? next.placeholder;
			picker.ariaLabel = picker.placeholder;
			picker.filterValue = value => value.slice(next.prefix.length);
			const controller = new AbortController();
			const instance = this.instantiationService.createInstance(next.ctor);
			const contribution = instance.provide(picker, next.prefix, controller.signal, options?.providerOptions);
			provider.value = toDisposable(() => {
				controller.abort();
				contribution.dispose();
			});
		};
		session.add(picker.onDidChangeValue(activate));
		session.add(picker.onDidHide(() => {
			this.active = undefined;
			this.visibilityChanged.fire(false);
			// Owners must receive the hide event before disposing its emitter; a new session may open during that event.
			queueMicrotask(() => {
				if (this.session.value === session) this.session.clear();
				else session.dispose();
			});
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
