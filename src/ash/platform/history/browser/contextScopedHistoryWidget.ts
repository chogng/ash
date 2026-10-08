import { addDisposableListener } from '../../../base/browser/dom.js';
import type { IHistoryNavigationWidget } from '../../../base/browser/history.js';
import { FindInput, type IFindInputOptions } from '../../../base/browser/ui/findinput/findInput.js';
import { ReplaceInput, type IReplaceInputOptions } from '../../../base/browser/ui/findinput/replaceInput.js';
import { HistoryInputBox, type IHistoryInputOptions } from '../../../base/browser/ui/inputbox/inputbox.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { DisposableStore, type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../commands/common/commands.js';
import { IContextKeyService } from '../../contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, type IContextKey, RawContextKey } from '../../contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../keybinding/common/keybindingsRegistry.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';

export const historyNavigationVisible = new RawContextKey<boolean>('suggestWidgetVisible', false);

const focusContext = new RawContextKey<boolean>('historyNavigationWidgetFocus', false);
const forwardsContext = new RawContextKey<boolean>('historyNavigationForwardsEnabled', true);
const backwardsContext = new RawContextKey<boolean>('historyNavigationBackwardsEnabled', true);

export interface IHistoryNavigationContext extends IDisposable {
	readonly historyNavigationForwardsEnablement: IContextKey<boolean>;
	readonly historyNavigationBackwardsEnablement: IContextKey<boolean>;
}

const registeredWidgets = new Set<IHistoryNavigationWidget>();
let focusedWidget: IHistoryNavigationWidget | undefined;

export function registerAndCreateHistoryNavigationContext(
	scopedContextKeyService: IContextKeyService,
	widget: IHistoryNavigationWidget,
): IHistoryNavigationContext {
	if (registeredWidgets.has(widget)) {
		throw new Error('Cannot register the same widget multiple times');
	}
	registeredWidgets.add(widget);

	const resources = new DisposableStore();
	const focus = focusContext.bindTo(scopedContextKeyService);
	const historyNavigationForwardsEnablement = forwardsContext.bindTo(scopedContextKeyService);
	const historyNavigationBackwardsEnablement = backwardsContext.bindTo(scopedContextKeyService);
	const handleFocus = (): void => {
		focus.set(true);
		focusedWidget = widget;
	};
	const handleBlur = (): void => {
		focus.set(false);
		if (focusedWidget === widget) focusedWidget = undefined;
	};

	resources.add(widget.onDidFocus(handleFocus));
	resources.add(widget.onDidBlur(handleBlur));
	resources.add(toDisposable(() => {
		registeredWidgets.delete(widget);
		handleBlur();
		historyNavigationForwardsEnablement.reset();
		historyNavigationBackwardsEnablement.reset();
	}));
	if (widget.element.contains(widget.element.ownerDocument.activeElement)) handleFocus();

	return Object.assign(toDisposable(() => resources.dispose()), {
		historyNavigationForwardsEnablement,
		historyNavigationBackwardsEnablement,
	});
}

export class ContextScopedHistoryInputBox<Flexible extends boolean = false> extends HistoryInputBox<Flexible> {
	constructor(container: HTMLElement, options: IHistoryInputOptions<Flexible>, @IContextKeyService contextKeyService: IContextKeyService) {
		super(container, options);
		const scope = this._register(contextKeyService.createScoped(this.element));
		const navigation = this._register(registerAndCreateHistoryNavigationContext(scope, this));
		const updateNavigation = (): void => {
			// Multiline arrows belong to caret movement; Alt+arrows are handled explicitly below.
			const multiline = this.value.includes('\n');
			navigation.historyNavigationBackwardsEnablement.set(!multiline);
			navigation.historyNavigationForwardsEnablement.set(!multiline);
		};
		this._register(this.onDidChange(updateNavigation));
		updateNavigation();
		this._register(addDisposableListener(this.inputElement, 'keydown', event => {
			if (event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) { return; }
			if (!event.altKey && this.value.includes('\n')) { return; }
			if (event.key === 'ArrowDown' && this.isNowhereInHistory()) { return; }
			event.preventDefault();
			event.stopPropagation();
			if (event.key === 'ArrowUp') { this.showPreviousValue(); } else { this.showNextValue(); }
			this.inputElement.setSelectionRange(this.value.length, this.value.length);
		}));
		// The scope must record focus before resolving the active keybinding hint.
		this._register(this.onDidFocus(() => this.updateHistoryHint()));
	}
}

export class ContextScopedFindInput<Flexible extends boolean = false> extends FindInput<Flexible> {
	constructor(container: HTMLElement, options: IFindInputOptions<Flexible>, @IInstantiationService instantiationService: IInstantiationService) {
		super(instantiationService.createInstance(ContextScopedHistoryInputBox<Flexible>, container, {
			...options,
			ariaLabel: options.label,
			placeholder: options.placeholder ?? options.label,
			history: options.history,
			showHistoryHint: options.showHistoryHint,
		}));
	}
}

export class ContextScopedReplaceInput<Flexible extends boolean = false> extends ReplaceInput<Flexible> {
	constructor(container: HTMLElement, options: IReplaceInputOptions<Flexible>, @IInstantiationService instantiationService: IInstantiationService) {
		super(instantiationService.createInstance(ContextScopedHistoryInputBox<Flexible>, container, {
			...options,
			ariaLabel: options.label,
			placeholder: options.placeholder ?? options.label,
			history: options.history,
			showHistoryHint: options.showHistoryHint,
		}));
	}
}

const historyEnabled = ContextKeyExpr.and(
	focusContext.isEqualTo(true),
	ContextKeyExpr.not(historyNavigationVisible.key),
);

CommandsRegistry.register('history.showPrevious', () => {
	if (focusedWidget && focusedWidget.element.contains(focusedWidget.element.ownerDocument.activeElement)) {
		focusedWidget.showPreviousValue();
	}
});
CommandsRegistry.register('history.showNext', () => {
	if (focusedWidget && focusedWidget.element.contains(focusedWidget.element.ownerDocument.activeElement)) {
		focusedWidget.showNextValue();
	}
});

for (const [command, key, enabled] of [
	['history.showPrevious', KeyCode.UpArrow, backwardsContext],
	['history.showNext', KeyCode.DownArrow, forwardsContext],
] as const) {
	const when = ContextKeyExpr.and(historyEnabled, enabled.isEqualTo(true));
	KeybindingsRegistry.registerKeybindingRule({ command, keybinding: key, when, priority: KeybindingWeight.WorkbenchContrib });
	KeybindingsRegistry.registerKeybindingRule({ command, keybinding: KeyMod.Alt | key, when, priority: KeybindingWeight.WorkbenchContrib });
}
