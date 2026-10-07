import './media/accessibleView.css';
import { h } from '../../../../base/browser/dom.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Disposable, MutableDisposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { localize } from '../../../../nls.js';
import { AccessibleViewType, type IAccessibleViewContentProvider, type IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { AccessibilityCommandId } from '../common/accessibilityCommands.js';
import { accessibilityHelpIsShown, accessibleViewIsShown, accessibleViewVerbosityEnabled, accessibleViewCurrentProviderId } from './accessibilityConfiguration.js';
import { resolveContentAndKeybindingItems } from './accessibleViewKeybindingResolver.js';

/** Displays one focused provider in a modal, read-only text surface. */
export class AccessibleViewService extends Disposable implements IAccessibleViewService {
	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	private readonly help = this._register(new MutableDisposable<DisposableStore>());
	private provider: IAccessibleViewContentProvider | undefined;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService private readonly accessor: IInstantiationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
	) {
		super();
	}

	public show(type: AccessibleViewType): boolean {
		// A modal surface already owns focus; looking up its previous feature
		// again would create a provider for an inactive element.
		if (this.provider) {
			if (type === AccessibleViewType.Help && this.provider.options.type === AccessibleViewType.View) {
				this.showAccessibleViewHelp();
				return true;
			}
			return false;
		}
		const root = this.layoutService.mainContainer;
		const activeElement = root.ownerDocument.activeElement;
		const implementations = [...AccessibleViewRegistry.getImplementations()]
			.filter(implementation => implementation.type === type && this.contextKeys.contextMatchesRules(implementation.when, activeElement))
			.sort((left, right) => right.priority - left.priority);
		let provider: IAccessibleViewContentProvider | undefined;
		for (const implementation of implementations) {
			provider = implementation.getProvider(this.accessor);
			if (provider) {
				break;
			}
		}
		if (!provider) {
			return false;
		}

		this.current.clear();
		const lifetime = new DisposableStore();
		const helpShown = accessibilityHelpIsShown.bindTo(this.contextKeys);
		const viewShown = accessibleViewIsShown.bindTo(this.contextKeys);
		const verbosityEnabled = accessibleViewVerbosityEnabled.bindTo(this.contextKeys);
		const providerId = accessibleViewCurrentProviderId.bindTo(this.contextKeys);
		lifetime.add(toDisposable(() => {
			this.provider = undefined;
			this.contextKeys.bufferChangeEvents(() => {
				helpShown.reset();
				viewShown.reset();
				verbosityEnabled.reset();
				providerId.reset();
			});
		}));
		lifetime.add(provider);
		try {
			const document = root.ownerDocument;
			const content = h(document, 'textarea');
			content.className = 'ash-accessible-view-content';
			content.readOnly = true;
			const selectedProvider = provider;
			const updateContent = (): void => {
				const value = selectedProvider.provideContent();
				const text = type === AccessibleViewType.Help
					? resolveContentAndKeybindingItems(this.keybindings, value)?.content.value ?? ''
					: value;
				this.updateText(content, text);
			};
			updateContent();
			const title = type === AccessibleViewType.Help
				? localize('accessibility.helpTitle', 'Accessibility Help')
				: localize('accessibility.viewTitle', 'Accessible View');
			content.setAttribute('aria-label', title);
			const dialog = lifetime.add(new Dialog(root, {
				title,
				content,
				buttons: [{ label: localize('accessibility.close', 'Close'), value: 'close' }],
				cancelValue: 'close',
			}));
			dialog.element.classList.add('ash-accessible-view-dialog');
			// Close child help before releasing the content dialog and its provider.
			lifetime.add(toDisposable(() => this.help.clear()));
			if (provider.onDidChangeContent) {
				lifetime.add(provider.onDidChangeContent(updateContent));
			}
			if (type === AccessibleViewType.Help) {
				lifetime.add(this.keybindings.onDidUpdateKeybindings(updateContent));
			}
			lifetime.add(this.configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(selectedProvider.verbositySettingKey)) {
					verbosityEnabled.set(this.configuration.getValue<boolean>(selectedProvider.verbositySettingKey));
				}
			}));
			this.provider = provider;
			this.contextKeys.bufferChangeEvents(() => {
				helpShown.set(type === AccessibleViewType.Help);
				viewShown.set(type === AccessibleViewType.View);
				verbosityEnabled.set(this.configuration.getValue<boolean>(selectedProvider.verbositySettingKey));
				providerId.set(selectedProvider.id);
			});
			this.current.value = lifetime;
			void dialog.show().finally(() => {
				if (this.current.value === lifetime) this.current.clear();
			});
		} catch (error) {
			if (this.current.value === lifetime) {
				this.current.clear();
			} else {
				lifetime.dispose();
			}
			throw error;
		}
		return true;
	}

	public getOpenAriaHint(verbositySettingKey: string): string | undefined {
		if (!this.configuration.getValue<boolean>(verbositySettingKey)) {
			return undefined;
		}
		const binding = this.keybindings.lookupKeybinding(AccessibilityCommandId.OpenAccessibilityHelp, this.contextKeys.getContext(this.layoutService.mainContainer.ownerDocument.activeElement));
		if (!binding) {
			return localize('accessibility.openHelpCommandHint', 'Run Open Accessibility Help from the Command Palette.');
		}
		return localize('accessibility.openHelpKeybindingHint', 'Press {0} for accessibility help.', getKeybindingLabel(binding));
	}

	public async disableHint(): Promise<void> {
		if (!this.provider) {
			return;
		}
		await this.configuration.updateValue(this.provider.verbositySettingKey, false);
	}

	public showAccessibleViewHelp(): void {
		if (!this.provider || this.provider.options.type !== AccessibleViewType.View || this.help.value) {
			return;
		}
		const lifetime = new DisposableStore();
		const helpShown = accessibilityHelpIsShown.bindTo(this.contextKeys);
		const viewShown = accessibleViewIsShown.bindTo(this.contextKeys);
		lifetime.add(toDisposable(() => this.contextKeys.bufferChangeEvents(() => {
			helpShown.set(false);
			viewShown.set(true);
		})));
		try {
			const root = this.layoutService.mainContainer;
			const content = h(root.ownerDocument, 'textarea');
			content.className = 'ash-accessible-view-content';
			content.readOnly = true;
			const title = localize('accessibility.helpTitle', 'Accessibility Help');
			content.setAttribute('aria-label', title);
			const helpContent = [
				localize('accessibility.viewHelpRead', 'Accessible View presents the current feature as read-only text. Use arrow keys to read, Home and End to move within a line, and Ctrl+Home or Command+Home to move to the beginning.'),
				localize('accessibility.viewHelpCopy', 'Use Shift with arrow keys to select text and Ctrl+C or Command+C to copy. Tab and Shift+Tab move between the text and Close.'),
				localize('accessibility.viewHelpHint', '<keybinding:editor.action.accessibleViewDisableHint> stops announcing the help hint for the current feature.'),
				localize('accessibility.viewHelpClose', 'Escape returns to the content. Press Escape again to close Accessible View and return to the feature.'),
			].join('\n\n');
			const updateContent = (): void => {
				this.updateText(content, resolveContentAndKeybindingItems(this.keybindings, helpContent)!.content.value);
			};
			updateContent();
			lifetime.add(this.keybindings.onDidUpdateKeybindings(updateContent));
			const dialog = lifetime.add(new Dialog(root, {
				title,
				content,
				buttons: [{ label: localize('accessibility.close', 'Close'), value: 'close' }],
				cancelValue: 'close',
			}));
			dialog.element.classList.add('ash-accessible-view-dialog');
			this.help.value = lifetime;
			this.contextKeys.bufferChangeEvents(() => {
				helpShown.set(true);
				viewShown.set(false);
			});
			void dialog.show().finally(() => {
				if (this.help.value === lifetime) {
					this.help.clear();
				}
			});
		} catch (error) {
			if (this.help.value === lifetime) {
				this.help.clear();
			} else {
				lifetime.dispose();
			}
			throw error;
		}
	}

	private updateText(content: HTMLTextAreaElement, text: string): void {
		if (content.value === text) {
			return;
		}
		const { selectionStart, selectionEnd, selectionDirection, scrollTop } = content;
		content.value = text;
		content.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
		content.scrollTop = scrollTop;
	}
}
