import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable } from '../../../base/common/lifecycle.js';
import { onWillUnregisterWindow } from '../../../base/browser/window.js';
import { IContextKeyService, type IScopedContextKeyService } from '../../contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../contextkey/common/contextkey.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import type { IQuickAccessController } from '../common/quickAccess.js';
import { QuickInputType, QuickPickFocus, type IInputOptions, type IKeyMods, type IQuickInput, type IQuickInputService, type IQuickPick, type IQuickPickItem } from '../common/quickInput.js';
import { endOfQuickInputBoxContext, inQuickInputContext, quickInputFocusContext, quickInputTypeContextKey } from './quickInput.js';
import { QuickAccessController } from './quickAccess.js';
import { QuickInputController } from './quickInputController.js';

/** Owns Quick Access and the shared input host within an application's service scope. */
export class QuickInputService extends Disposable implements IQuickInputService {
	private readonly inputControllers = this._register(new DisposableMap<HTMLElement, QuickInputController>());
	private accessController: QuickAccessController | undefined;
	private readonly shown = this._register(new Emitter<void>());
	private readonly hidden = this._register(new Emitter<void>());
	public readonly onShow = this.shown.event;
	public readonly onHide = this.hidden.event;
	private readonly inQuickInput;
	private readonly visibleInputs = new Set<IQuickInput>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService protected readonly contextKeyService: IContextKeyService,
		@ILayoutService protected readonly layoutService: ILayoutService,
	) {
		super();
		this.inQuickInput = inQuickInputContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.inQuickInput.reset()));
		this._register(layoutService.onDidLayoutActiveContainer(() => {
			this.inputControllers.get(layoutService.activeContainer)?.layout(layoutService.activeContainerDimension, layoutService.activeContainerOffset.quickInputTop);
		}));
		this._register(layoutService.onDidChangeActiveContainer(() => {
			// A provider captures the editor at invocation; dismiss it before another window takes over.
			for (const [container, controller] of this.inputControllers) {
				if (container !== layoutService.activeContainer) controller.currentQuickInput?.hide();
			}
		}));
		this._register(onWillUnregisterWindow(({ window }) => {
			for (const [container] of this.inputControllers) {
				if (container.ownerDocument.defaultView === window) this.inputControllers.deleteAndDispose(container);
			}
		}));
	}

	public get quickAccess(): IQuickAccessController {
		this.assertNotDisposed();
		return this.accessController ??= this._register(this.instantiationService.createInstance(QuickAccessController));
	}

	protected get controller(): QuickInputController {
		this.assertNotDisposed();
		const container = this.layoutService.activeContainer;
		return this.inputControllers.get(container) ?? this.inputControllers.set(container, this.createController());
	}

	protected createController(className?: string): QuickInputController {
		let scope: IScopedContextKeyService;
		let type: IContextKey<string>;
		let focus: IContextKey<boolean>;
		let end: IContextKey<boolean>;
		const controller = new QuickInputController(this.layoutService.activeContainer, className, {
			onShow: input => {
				for (const [, controller] of this.inputControllers) {
					if (controller.currentQuickInput !== input) controller.currentQuickInput?.hide();
				}
				this.visibleInputs.add(input);
				type.set(input.type);
				this.inQuickInput.set(true);
				this.shown.fire();
			},
			onHide: input => {
				this.visibleInputs.delete(input);
				type.reset(); focus.reset(); end.reset();
				if (!this.visibleInputs.size) this.inQuickInput.reset();
				this.hidden.fire();
			},
			onFocus: (withinInput, atEnd) => { focus.set(withinInput); end.set(atEnd); },
			getContext: target => this.contextKeyService.getContext(target),
			// Dismissing an overlay during a window switch must leave focus in the new window.
			shouldRestoreFocus: () => this.layoutService.activeContainer === controller.getDomNode().parentElement,
			onDispose: () => scope.dispose(),
		});
		// Context belongs to this DOM host and is released with it, including standalone editors.
		scope = this.contextKeyService.createScoped(controller.getDomNode());
		type = quickInputTypeContextKey.bindTo(scope);
		focus = quickInputFocusContext.bindTo(scope);
		end = endOfQuickInputBoxContext.bindTo(scope);
		controller.layout(this.layoutService.activeContainerDimension, this.layoutService.activeContainerOffset.quickInputTop);
		return controller;
	}

	public get currentQuickInput(): IQuickInput | undefined {
		return this.inputControllers.get(this.layoutService.activeContainer)?.currentQuickInput;
	}

	public createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		return this.controller.createQuickPick<TItem>();
	}

	public input(options: IInputOptions = {}, token: CancellationToken = CancellationToken.None): Promise<string | undefined> {
		return this.controller.input(options, token);
	}

	public focus(): void { this.currentQuickInput?.focus(); }

	public toggle(): void {
		if (this.currentQuickInput?.type === QuickInputType.QuickPick) (this.currentQuickInput as IQuickPick<IQuickPickItem>).toggle();
	}

	public navigate(next: boolean): void {
		if (this.currentQuickInput?.type === QuickInputType.QuickPick) {
			(this.currentQuickInput as IQuickPick<IQuickPickItem>).focus(next ? QuickPickFocus.Next : QuickPickFocus.Previous);
		}
	}

	public async accept(keyMods?: IKeyMods): Promise<void> {
		const current = this.currentQuickInput;
		if (current?.type === QuickInputType.QuickPick && keyMods) (current as IQuickPick<IQuickPickItem>).keyMods = keyMods;
		await current?.accept();
	}

	public async cancel(): Promise<void> { this.currentQuickInput?.hide(); }
}
