import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { h } from '../../../../base/browser/dom.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { Action2, IMenuService, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsConversationService } from '../../../services/sessions/common/sessionsConversation.js';
import {
	FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_KEYBINDING, FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_WHEN,
	FOCUS_NEW_SESSION_WORKSPACE_PICKER_KEYBINDING, FOCUS_NEW_SESSION_WORKSPACE_PICKER_WHEN,
} from './newChatPickerKeybinding.js';
import { SessionEnvironmentPicker } from './sessionEnvironmentPicker.js';
import { SessionWorkspacePicker } from './sessionWorkspacePicker.js';
import { ASH_CHAT_SELECTED_CONTEXT } from '../common/constants.js';

export const BackgroundSendAvailableContext = new RawContextKey<boolean>('sessions.backgroundSendAvailable', false);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.sendInBackground',
			title: localize2('sessions.chat.backgroundSend.action', 'Send in Background'),
			f1: true,
			precondition: BackgroundSendAvailableContext.isEqualTo(true),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: ChatContextKeys.inChatInput.isEqualTo(true),
				weight: KeybindingWeight.SessionsContrib,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (!widget?.visible) return;
		widget.input.focus();
		await widget.acceptInput(undefined, { background: true });
	}
});

const pickers = [
	{
		kind: 'environment',
		id: 'sessions.focusNewSessionEnvironmentPicker',
		title: localize2('sessions.focusNewSessionEnvironmentPicker', 'Focus Environment Picker'),
		keybinding: FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_KEYBINDING,
		when: FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_WHEN,
	},
	{
		kind: 'workspace',
		id: 'sessions.focusNewSessionWorkspacePicker',
		title: localize2('sessions.focusNewSessionWorkspacePicker', 'Focus Project Picker'),
		keybinding: FOCUS_NEW_SESSION_WORKSPACE_PICKER_KEYBINDING,
		when: FOCUS_NEW_SESSION_WORKSPACE_PICKER_WHEN,
	},
] as const;

type ComposerPicker = typeof pickers[number]['kind'];

for (const [order, { kind, id, title, keybinding, when }] of pickers.entries()) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id, title, f1: true, precondition: when,
				keybinding: { weight: KeybindingWeight.SessionsContrib, primary: keybinding },
			});
		}

		override run(accessor: ServicesAccessor): void {
			accessor.get(ISessionsConversationService).focusDraftPicker(kind);
		}
	});

	// The keyboard command requires editor focus. The toolbar's native triggers own their enablement.
	MenusRegistry.appendMenuItem(Menus.NewSessionChatInputToolbar, {
		command: { id, title }, group: 'navigation', order,
		when: kind === 'environment' ? ContextKeyExpr.not(ASH_CHAT_SELECTED_CONTEXT) : undefined,
	});
}

class ComposerPickerActionViewItem extends ActionViewItem {
	private picker: SessionWorkspacePicker | SessionEnvironmentPicker | undefined;
	private trigger: HTMLButtonElement | undefined;

	constructor(
		action: IAction,
		private readonly kind: ComposerPicker,
		private readonly owner: ComposerSessionControls,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(action);
	}

	override render(container: HTMLElement): void {
		if (this.kind === 'workspace') {
			const picker = this.picker = this._register(this.instantiation.createInstance(SessionWorkspacePicker, container, this.owner.model));
			this._register(picker.renderRecentProjects(this.owner.setupCard));
		} else {
			const picker = this.picker = this._register(this.instantiation.createInstance(SessionEnvironmentPicker, this.owner.model, this.owner.persistDraft));
			this._register(picker.render(container, this.owner.setupCard));
		}
		this.trigger = container.querySelector('button') ?? undefined;
		this.setVisible(this.owner.visible);
	}

	override setTabbable(tabbable: boolean): void {
		if (this.trigger) this.trigger.tabIndex = tabbable ? 0 : -1;
	}

	override focus(): void { this.trigger?.focus(); }
	setVisible(visible: boolean): void { this.picker?.setVisible(visible); }
	open(): void { this.picker?.showPicker(); }
}

/** Connects the footer toolbar to one composer's model and draft checkpoint. */
export class ComposerSessionControls extends Disposable {
	readonly setupCard: HTMLElement;
	private readonly items = new Map<string, ComposerPickerActionViewItem>();
	private isVisible = true;
	get visible(): boolean { return this.isVisible; }

	constructor(
		footer: HTMLElement,
		environmentSetup: HTMLElement,
		readonly model: IChatWidgetModel,
		readonly persistDraft: () => Promise<void>,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IActionViewItemService presentations: IActionViewItemService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.setupCard = h(environmentSetup.ownerDocument, 'div', { className: 'ash-sessions-environment-card' });
		environmentSetup.append(this.setupCard);
		this._register(toDisposable(() => this.setupCard.remove()));
		const menu = Menus.NewSessionChatInputToolbar;
		const toolbar = this._register(new MenuWorkbenchToolBar(footer, menus, contextMenus, menu, {
			ariaLabel: localize('sessions.newChatComposer.sessionControls', 'Session controls'),
			tabNavigation: 'each-action',
			actionViewItemProvider: (action, options) => {
				if (!pickers.some(picker => picker.id === action.id)) return undefined;
				const item = presentations.lookUp(menu, action.id)?.(action, { ...options, actionContext: this }, instantiation, 0);
				if (!(item instanceof ComposerPickerActionViewItem)) {
					throw new Error(`Missing composer picker presentation for ${action.id}`);
				}
				this.items.set(action.id, item);
				return item;
			},
		}));
		toolbar.element.classList.add('ash-sessions-composer-controls');
		footer.prepend(toolbar.element);
		this._register(toDisposable(() => toolbar.element.remove()));
		const update = (): void => { toolbar.element.hidden = !model.untitledSessionId; };
		update();
		this._register(model.onDidChange(update));
	}

	setVisible(visible: boolean): void {
		this.isVisible = visible;
		for (const item of this.items.values()) {
			if (!item.isDisposed) item.setVisible(visible);
		}
	}

	open(kind: ComposerPicker): void {
		const picker = pickers.find(picker => picker.kind === kind);
		const item = picker && this.items.get(picker.id);
		if (this.visible && item && !item.isDisposed) item.open();
	}
}

/** Installs the new-session toolbar's picker presenters before view restoration. */
export class SharedChatInputComposerContribution extends Disposable {
	static readonly ID = 'sessions.contrib.sharedChatInputComposer';

	constructor(@IActionViewItemService presentations: IActionViewItemService) {
		super();
		for (const { kind, id } of pickers) {
			this._register(presentations.register(Menus.NewSessionChatInputToolbar, id, (action, options, instantiation) => {
				const owner = options.actionContext;
				return owner instanceof ComposerSessionControls
					? instantiation.createInstance(ComposerPickerActionViewItem, action, kind, owner)
					: undefined;
			}));
		}
	}
}

registerWorkbenchContribution(SharedChatInputComposerContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(SharedChatInputComposerContribution));
