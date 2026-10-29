import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ResourceEditor, defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('resourceEditor.invalidVerbosity', 'Resource editor accessibility verbosity must be boolean.'));
		return value;
	},
	setting: {
		included: false,
		valueType: 'boolean',
		get title() { return localize('resourceEditor.verbosityTitle', 'Resource editor accessibility help'); },
		get description() { return localize('resourceEditor.verbosityDescription', 'Announce how to open accessibility help in resource editors.'); },
	},
});

/** The host owns help presentation and focus; each admitted package supplies its own text. */
export function registerResourceEditorAccessibility(container: HTMLElement, configuration: IConfigurationService, content: () => string, help: () => string): DisposableStore {
	const lifetime = new DisposableStore();
	const name = `resource-editor-${createUuid()}`;
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		lifetime.add(AccessibleViewRegistry.register({
			name, type, priority: 115,
			getProvider() {
				const active = getActiveElement(container.ownerDocument);
				if (!isHTMLElement(active) || !container.contains(active)) return undefined;
				return new AccessibleContentProvider(AccessibleViewProviderId.ResourceEditor, { type }, type === AccessibleViewType.Help ? help : content,
					() => { if (active.isConnected) active.focus(); else if (container.isConnected) container.focus(); }, AccessibilityVerbositySettingId.ResourceEditor);
			},
		}));
	}
	const updateHint = () => {
		if (configuration.getValue<boolean>(AccessibilityVerbositySettingId.ResourceEditor) !== false) {
			container.setAttribute('aria-description', localize('resourceEditor.helpHint', 'Use Open Accessibility Help for keyboard instructions and Open Accessible View to read this resource as text.'));
		} else container.removeAttribute('aria-description');
	};
	updateHint();
	lifetime.add(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.ResourceEditor)) updateHint(); }));
	return lifetime;
}
