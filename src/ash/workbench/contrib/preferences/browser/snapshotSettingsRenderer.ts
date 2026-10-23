import { Emitter } from '../../../../base/common/event.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { localize } from '../../../../nls.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IPreferencesService, type ISetting } from '../../../services/preferences/common/preferences.js';
import { DefaultSettings } from '../../../services/preferences/common/settingsModels.js';
import { ScreenshotCommandId } from '../../chat/common/constants.js';
import { SettingsLayout } from './settingsLayout.js';
import { SettingsPageRenderer } from './settingsRenderers.js';
import { SettingsSectionRenderer } from './settingsSectionRenderer.js';
import type { SettingsSectionField, SettingsSectionReference, SettingsSectionModel, SettingsTreeNode } from './settingsTreeModels.js';
import './media/snapshotSettings.css';

/** Preferences owns grouping and shortcut links; the extension owns setting schemas and values. */
export class SnapshotSettingsRenderer extends SettingsPageRenderer {
	readonly categoryId = 'extension.ash.snapshot';
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly shortcuts: readonly SettingsSectionRenderer[];
	private get settings(): readonly ISetting[] {
		return new DefaultSettings().all.filter(setting => setting.configuration.source?.id === 'ash.snapshot');
	}
	override get settingIds(): readonly string[] { return this.settings.map(setting => setting.id); }

	constructor(container: HTMLElement,
		@IInstantiationService instantiation: IInstantiationService,
		@IKeybindingService keybindings: IKeybindingService,
		@IPreferencesService preferences: IPreferencesService,
	) {
		super();
		this.shortcuts = [ScreenshotCommandId, 'snapshot.code'].map((command, index) => {
			const categoryId = this.categoryId;
			const model: SettingsSectionModel = {
				categoryId,
				itemId: `snapshot.${index === 0 ? 'screen' : 'code'}.shortcut`,
				title: localize({ bundle: 'ash.settings', key: 'snapshot.shortcut' }, 'Keyboard shortcut'),
				description: '',
				help: localize({ bundle: 'ash.settings', key: 'snapshot.shortcutHelp' }, 'Screenshot shortcuts\nUse Tab to reach Change Shortcut and press Enter to open this command in Keyboard Shortcuts. Changes apply to the shortcut shown here. Screen captures can be copied, saved, or added to chat. The background shortcut uses the same screen capture binding. Code images render selected editor text without screen recording permission. Escape closes help and restores focus.'),
				onDidChange: keybindings.onDidUpdateKeybindings,
				get fields(): readonly SettingsSectionField[] {
					const binding = keybindings.lookupKeybinding(command);
					const label = binding ? getKeybindingLabel(binding) : localize({ bundle: 'ash.settings', key: 'snapshot.unassigned' }, 'Not set');
					return [{ id: 'binding', kind: 'status', text: label }, {
						id: 'edit', kind: 'action', enabled: true,
						label: localize({ bundle: 'ash.settings', key: 'snapshot.changeShortcut' }, 'Change Shortcut'),
						run: async () => { await preferences.openGlobalKeybindingSettings(false, { query: `@command:${command}` }); },
					}];
				},
				setVisible: () => { },
			};
			const renderer = this._register(instantiation.createInstance(SettingsSectionRenderer, container, model, AccessibleViewProviderId.ChatScreenshot, AccessibilityVerbositySettingId.ChatScreenshot));
			this._register(renderer.onDidChange(() => this.changed.fire()));
			return renderer;
		});
	}

	protected override buildNodes(): readonly SettingsTreeNode<ISetting | SettingsSectionReference>[] {
		const settings = this.settings;
		if (!settings.length) return [];
		const groups = new SettingsLayout(this.categoryId, [{
			id: 'screen',
			title: localize({ bundle: 'ash.settings', key: 'snapshot.screen' }, 'Screen capture'),
			description: localize({ bundle: 'ash.settings', key: 'snapshot.screenDescription' }, 'Select and annotate screen content, then copy, save, or add it to chat.'),
			settings: settings.filter(setting => !setting.id.startsWith('snapshot.code.')),
		}, {
			id: 'code',
			title: localize({ bundle: 'ash.settings', key: 'snapshot.code' }, 'Code images'),
			description: localize({ bundle: 'ash.settings', key: 'snapshot.codeDescription' }, 'Create an image from selected code. Screen recording permission is not needed.'),
			settings: settings.filter(setting => setting.id.startsWith('snapshot.code.')),
		}]).nodes;
		return groups.map((group, index) => ({
			...group,
			children: [
				...this.shortcuts[index].getNodes().flatMap(node => node.children ?? []).map(node => {
					if (node.element.kind !== 'item') throw new Error('Expected a screenshot shortcut item');
					const element = this.shortcuts[index].renderItem(node.element.value);
					element.classList.add('ash-snapshot-shortcut');
					return { element: { ...node.element, value: this.retainElement(node.element.id, element) } };
				}),
				...(group.children ?? []),
			],
		}));
	}

	override setVisible(visible: boolean): void {
		for (const shortcut of this.shortcuts) shortcut.setVisible(visible);
	}
}
