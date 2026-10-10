import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IAccessibleViewService, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITerminalService, type ITerminalContribution, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import type { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalAccessibilityHelpProvider } from './terminalAccessibilityHelp.js';
import { TerminalAccessibleBufferProvider } from './terminalAccessibleBufferProvider.js';

export class TerminalAccessibleViewContribution extends Disposable implements ITerminalContribution {
	public static readonly ID = 'terminal.accessibleBufferProvider';

	constructor(
		_context: ITerminalContributionContext,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { super(); }

	public xtermReady(screen: XtermTerminal): void {
		const updateLabel = (): void => {
			const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Terminal);
			screen.raw.textarea?.setAttribute('aria-label', [localize('terminal.accessibility.input', 'Terminal input'), hint].filter(Boolean).join('. '));
		};
		updateLabel();
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Terminal)) updateLabel();
		}));
	}
}

function focusedInstance(accessor: ServicesAccessor): ITerminalInstance | undefined {
	const instance = accessor.get(ITerminalService).activeInstance;
	const screen = instance?.xterm;
	return screen && !screen.isDisposed && screen.raw.textarea === screen.element.ownerDocument.activeElement ? instance : undefined;
}

registerTerminalContribution(TerminalAccessibleViewContribution.ID, TerminalAccessibleViewContribution);
AccessibleViewRegistry.register({
	name: 'terminal', type: AccessibleViewType.Help, priority: 90, when: TerminalContextKeys.focus.isEqualTo(true),
	getProvider: accessor => {
		const instance = focusedInstance(accessor);
		return instance ? new TerminalAccessibilityHelpProvider(instance) : undefined;
	},
});
AccessibleViewRegistry.register({
	name: 'terminal', type: AccessibleViewType.View, priority: 90, when: TerminalContextKeys.focus.isEqualTo(true),
	getProvider: accessor => {
		const instance = focusedInstance(accessor);
		return instance?.xterm ? new TerminalAccessibleBufferProvider(instance, instance.xterm) : undefined;
	},
});
