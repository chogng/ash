import { getActiveElement, isHTMLElement } from '../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, type IObservable } from '../../../base/common/observable.js';
import { localize, localize2 } from '../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, type ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { MenuActivityBar } from '../../../workbench/browser/parts/activitybar/menuActivityBar.js';
import { SessionsCodeEditorContext } from '../../../workbench/common/contextkeys.js';
import { SessionsConfiguration } from '../../common/configuration.js';
import { Menus, SessionActivityBarVisibleContext } from '../menus.js';

/** Places the Code tool commands next to the conversation while that host is visible. */
export class SessionActivityBar extends Disposable {
	constructor(
		container: HTMLElement,
		conversationVisible: IObservable<boolean>,
		focusConversation: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleViewService: IAccessibleViewService,
	) {
		super();
		const setting = SessionsConfiguration.showSessionActivityBar;
		const label = localize('sessions.sessionActivityBar.title', 'Session Activity Bar');
		const visible = SessionActivityBarVisibleContext.bindTo(contextKeys);
		this._register(toDisposable(() => visible.reset()));
		const bar = this._register(instantiationService.createInstance(MenuActivityBar, container, {
			menuId: Menus.SessionActivityBar,
			contextMenuId: Menus.SessionActivityBarContext,
			ariaLabel: label,
		}));
		const verbosity = AccessibilityVerbositySettingId.SessionsActivityBar;
		const scopedContext = this._register(contextKeys.createScoped(bar.element));
		scopedContext.createKey('sessionActivityBarFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 100,
			name: 'sessionActivityBarHelp',
			when: ContextKeyExpr.has('sessionActivityBarFocused'),
			getProvider: () => {
				const focused = getActiveElement(bar.element.ownerDocument);
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsActivityBar,
					{ type: AccessibleViewType.Help },
					() => localize('sessions.sessionActivityBar.help', 'Use Tab to reach the Session Activity Bar. Use Up and Down Arrow to move between tools, and Enter or Space to open or close the focused tool. Press Shift+F10 to hide the activity bar and return its tools to the title bar.'),
					() => {
						if (isHTMLElement(focused) && !bar.element.hidden) focused.focus();
					},
					verbosity,
				);
			},
		}));
		const updateHelpHint = (): void => {
			const hint = accessibleViewService.getOpenAriaHint(verbosity);
			if (hint) bar.element.setAttribute('aria-description', hint);
			else bar.element.removeAttribute('aria-description');
		};
		updateHelpHint();
		const enabled = observableFromEvent(this, configuration.onDidChangeConfiguration, () => configuration.getValue<boolean>(setting));
		this._register(autorun(reader => {
			visible.set(conversationVisible.read(reader) && enabled.read(reader));
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(verbosity)) updateHelpHint();
		}));
		this._register(registerAction2(class ToggleSessionActivityBar extends Action2 {
			constructor() {
				super({
					id: 'ash.sessions.toggleSessionActivityBar',
					title: localize2('sessions.sessionActivityBar.toggle', 'Toggle Session Activity Bar'),
					f1: true,
					precondition: SessionsCodeEditorContext.isEqualTo(true),
					menu: { id: Menus.SessionActivityBarContext },
				});
			}

			override async run(accessor: ServicesAccessor): Promise<void> {
				if (contextKeys.getValue(SessionsCodeEditorContext.key) !== true) return;
				const configuration = accessor.get(IConfigurationService);
				const show = !configuration.getValue<boolean>(setting);
				const document = bar.element.ownerDocument;
				const focusedBar = !show && bar.element.contains(getActiveElement(document));
				await configuration.updateValue(setting, show);
				if (focusedBar && getActiveElement(document) === document.body) focusConversation();
			}
		}));
	}
}
