import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { CustomizeEditorPane } from './customizeEditor.js';

registerEditorPane({
	id: 'sessions.editor.customize',
	name: localize('customize.title', 'Customize'),
	canOpen: input => (input.resource.scheme === 'ash-customize' ? EditorPaneMatch.Default : EditorPaneMatch.None),
	create: options => options.instantiationService!.createInstance(CustomizeEditorPane),
});

registerAction2(
	class OpenCustomize extends Action2 {
		constructor() {
			super({
				id: 'sessions.open.customize',
				title: localize2('customize.title', 'Customize'),
				icon: Lxicon.briefcase,
				f1: true,
				toggled: ContextKeyExpr.has('sessions.activity.customizeSelected'),
				menu: [Menus.ActivityBar, Menus.CodeActivityBar].map(id => ({ id, group: 'navigation', order: 50 })),
			});
		}
		public override async run(accessor: ServicesAccessor, source?: unknown): Promise<void> {
			await accessor.get(ISessionsLayoutService).openEntry(
				{
					id: 'customize',
					activityContext: 'sessions.activity.customizeSelected',
					content: 'editor',
					showEditorTabs: false,
					restoreCommand: 'sessions.open.customize',
					focus: 'editor',
					editorInput: {
						resource: URI.from({ scheme: 'ash-customize', path: '/page' }),
						label: localize('customize.title', 'Customize'),
						showBreadcrumbs: false,
						readOnly: true,
						capabilities: EditorInputCapabilities.CannotClose,
					},
				},
				undefined,
				source === 'restore' ? { source } : undefined,
			);
		}
	},
);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Customize,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Customize accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('customize.verbosityTitle', 'Customize accessibility help'),
		description: localize('customize.verbosityDescription', 'Announce how to open keyboard help when Customize receives focus.'),
	},
});
