import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ITerminalService, type ITerminalContribution, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import type { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { TERMINAL_VIEW_ID } from '../../../terminal/common/terminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalFindCommandId } from '../common/terminal.find.js';
import { TerminalFindWidget } from './terminalFindWidget.js';
import { TerminalFindAccessibilityHelp } from './terminalFindAccessibilityHelp.js';

export class TerminalFindContribution extends Disposable implements ITerminalContribution {
	public static readonly ID = 'terminal.find';
	private readonly widget = this._register(new MutableDisposable<TerminalFindWidget>());
	private rendererServices: IInstantiationService | undefined;

	constructor(
		private readonly context: ITerminalContributionContext,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) { super(); }

	public static get(instance: ITerminalInstance): TerminalFindContribution | null {
		return instance.getContribution<TerminalFindContribution>(TerminalFindContribution.ID);
	}

	public get findWidget(): TerminalFindWidget {
		this.assertNotDisposed();
		if (!this.rendererServices) { throw new Error('Terminal screen is not ready'); }
		return this.widget.value ??= this.rendererServices.createInstance(TerminalFindWidget, this.context.instance);
	}

	public xtermReady(xterm: XtermTerminal): void {
		const scope = this._register(this.contextKeys.createScoped(xterm.element));
		this.rendererServices = this._register(this.instantiation.createChild(new ServiceCollection([IContextKeyService, scope])));
		const focused = TerminalContextKeys.focus.bindTo(scope);
		const textarea = xterm.raw.textarea;
		// A newly created screen can receive its requested focus before this hook runs.
		focused.set(textarea === xterm.element.ownerDocument.activeElement);
		this._register(addDisposableListener(xterm.element, 'focusin', event => focused.set(event.target === textarea)));
		this._register(addDisposableListener(xterm.element, 'focusout', event => {
			focused.set(event.relatedTarget === textarea);
		}));
	}
}

registerTerminalContribution(TerminalFindContribution.ID, TerminalFindContribution);
AccessibleViewRegistry.register(new TerminalFindAccessibilityHelp());

const focused = ContextKeyExpr.or(TerminalContextKeys.focus.isEqualTo(true), TerminalContextKeys.findFocus.isEqualTo(true));

registerAction2(class TerminalFindFocusAction extends Action2 {
	constructor() {
		super({
			id: TerminalFindCommandId.FindFocus,
			title: localize2('terminal.find.focusAction', 'Terminal: Focus find'),
			f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyF, when: focused, weight: KeybindingWeight.WorkbenchContrib },
			menu: { id: MenuId.MenubarTerminalMenu, group: '2_terminal', order: 1 },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(TERMINAL_VIEW_ID);
		const instance = accessor.get(ITerminalService).activeInstance;
		if (instance && await instance.xtermReadyPromise && accessor.get(ITerminalService).activeInstance === instance) {
			const widget = TerminalFindContribution.get(instance)?.findWidget;
			widget?.reveal(widget.isVisible() ? undefined : instance.xterm?.raw.getSelection() || undefined);
		}
	}
});

const actions: readonly {
	id: TerminalFindCommandId;
	title: ReturnType<typeof localize2>;
	key: number;
	mac?: { primary: number; secondary?: readonly number[]; };
	run: (widget: TerminalFindWidget) => void;
}[] = [
		{
			id: TerminalFindCommandId.FindHide,
			title: localize2('terminal.find.hideAction', 'Terminal: Hide find'),
			key: KeyCode.Escape,
			run: widget => widget.hide(),
		},
		{
			id: TerminalFindCommandId.FindNext,
			title: localize2('terminal.find.nextAction', 'Terminal: Find next'),
			key: KeyCode.F3,
			mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyG, secondary: [KeyCode.F3] },
			run: widget => { widget.show(); widget.find(false); },
		},
		{
			id: TerminalFindCommandId.FindPrevious,
			title: localize2('terminal.find.previousAction', 'Terminal: Find previous'),
			key: KeyMod.Shift | KeyCode.F3,
			mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG, secondary: [KeyMod.Shift | KeyCode.F3] },
			run: widget => { widget.show(); widget.find(true); },
		},
		{
			id: TerminalFindCommandId.ToggleFindCaseSensitive,
			title: localize2('terminal.find.caseAction', 'Terminal: Toggle match case'),
			key: KeyMod.Alt | KeyCode.KeyC,
			mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyC },
			run: widget => widget.changeState({ matchCase: !widget.state.matchCase }),
		},
		{
			id: TerminalFindCommandId.ToggleFindWholeWord,
			title: localize2('terminal.find.wordAction', 'Terminal: Toggle whole word'),
			key: KeyMod.Alt | KeyCode.KeyW,
			mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyW },
			run: widget => widget.changeState({ wholeWord: !widget.state.wholeWord }),
		},
		{
			id: TerminalFindCommandId.ToggleFindRegex,
			title: localize2('terminal.find.regexAction', 'Terminal: Toggle regular expression'),
			key: KeyMod.Alt | KeyCode.KeyR,
			mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR },
			run: widget => widget.changeState({ isRegex: !widget.state.isRegex }),
		},
	];
for (const action of actions) {
	const navigation = action.id === TerminalFindCommandId.FindNext || action.id === TerminalFindCommandId.FindPrevious;
	registerAction2(class TerminalFindAction extends Action2 {
		constructor() {
			super({
				id: action.id,
				title: action.title,
				f1: true,
				keybinding: {
					primary: action.key,
					mac: action.mac,
					when: navigation ? focused : ContextKeyExpr.and(focused, TerminalContextKeys.findVisible.isEqualTo(true)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const instance = accessor.get(ITerminalService).activeInstance;
			if (!instance?.xterm || !await instance.xtermReadyPromise || accessor.get(ITerminalService).activeInstance !== instance) { return; }
			const contribution = TerminalFindContribution.get(instance);
			if (contribution && (navigation || contribution.findWidget.isVisible())) { action.run(contribution.findWidget); }
		}
	});
}
