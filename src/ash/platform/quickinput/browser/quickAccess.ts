import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../common/quickInput.js';
import { QuickAccessRegistry, type IQuickAccessController, type IQuickAccessProviderDescriptor } from '../common/quickAccess.js';

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

	show(value = ''): void {
		if (this.active) {
			this.active.value = value;
			this.active.show();
			this.active.valueSelection = { start: QuickAccessRegistry.get(value)?.prefix.length ?? 0, end: value.length };
			return;
		}
		const session = new DisposableStore();
		const picker = session.add(this.quickInputService.createQuickPick<IQuickPickItem>());
		const provider = session.add(new MutableDisposable());
		let descriptor: IQuickAccessProviderDescriptor | undefined;
		const activate = (input: string): void => {
			const next = QuickAccessRegistry.get(input);
			if (next === descriptor) return;
			provider.clear();
			descriptor = next;
			picker.items = [];
			if (!next) return;
			picker.placeholder = next.placeholder;
			picker.ariaLabel = next.placeholder;
			picker.filterValue = value => value.slice(next.prefix.length);
			const controller = new AbortController();
			const instance = this.instantiationService.createInstance(next.ctor);
			const contribution = instance.provide(picker, next.prefix, controller.signal);
			provider.value = toDisposable(() => {
				controller.abort();
				contribution.dispose();
			});
		};
		session.add(picker.onDidChangeValue(activate));
		session.add(picker.onDidHide(() => {
			this.active = undefined;
			this.visibilityChanged.fire(false);
			this.session.clear();
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
