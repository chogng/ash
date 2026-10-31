import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import type { SettingsSectionModel } from '../common/preferences.js';

export interface SettingsSectionContribution {
	readonly id: string;
	readonly categoryId: string;
	readonly model: SyncDescriptor<SettingsSectionModel & IDisposable>;
	readonly accessibleViewProviderId: AccessibleViewProviderId;
	readonly accessibilityVerbositySettingId: AccessibilityVerbositySettingId;
}

// Declarations are realm-owned; each Settings opening creates and disposes its own models.
const sections = new Map<string, SettingsSectionContribution>();

export function registerSettingsSection(section: SettingsSectionContribution): IDisposable {
	if (sections.has(section.id)) { throw new Error(`Settings section is already registered: ${section.id}`); }
	sections.set(section.id, section);
	return toDisposable(() => sections.delete(section.id));
}

export function getSettingsSections(): readonly SettingsSectionContribution[] {
	return [...sections.values()];
}
