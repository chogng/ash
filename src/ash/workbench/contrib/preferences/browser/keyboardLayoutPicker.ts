import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeyboardConfiguration } from '../../../../platform/keyboardLayout/common/keyboardConfiguration.js';
import { IKeyboardLayoutService, type IKeyboardLayoutInfo } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { IUserKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/userKeyboardLayout.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IKeyboardShortcutTroubleshootingService } from '../../../services/keybinding/common/keyboardShortcutTroubleshooting.js';
import { IOutputService } from '../../../services/output/common/output.js';
import {
	ChangeKeyboardLayoutCommandId,
	InspectKeyMappingsCommandId,
	InspectKeyMappingsJsonCommandId,
	ToggleKeyboardShortcutsTroubleshootingCommandId,
} from '../common/preferences.js';

const KeyboardShortcutsOutputChannelId = 'keyboard-shortcuts';

interface LayoutQuickPickItem extends IQuickPickItem {
	readonly kind: 'autodetect' | 'configure' | 'layout';
	readonly layout?: IKeyboardLayoutInfo;
}

registerAction2(class ChangeKeyboardLayoutAction extends Action2 {
	constructor() {
		super({
			id: ChangeKeyboardLayoutCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.ChangeKeyboardLayoutAction' }, 'Preferences: Change Keyboard Layout'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const keyboardLayouts = accessor.get(IKeyboardLayoutService);
		const configuration = accessor.get(IConfigurationService);
		const userLayout = accessor.get(IUserKeyboardLayoutService);
		const picker = accessor.get(IQuickInputService).createQuickPick<LayoutQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		const requested = configuration.getValue(KeyboardConfiguration.layout);
		const current = keyboardLayouts.getCurrentKeyboardLayout();
		const layouts = [...keyboardLayouts.getAllKeyboardLayouts()]
			.sort((first, second) => first.label.localeCompare(second.label));

		picker.placeholder = localize({ bundle: 'ash.workbench', key: 'keyboardLayout.selectLayout' }, 'Select keyboard layout');
		picker.ariaLabel = picker.placeholder;
		picker.items = [
			{
				kind: 'autodetect',
				label: localize({ bundle: 'ash.workbench', key: 'keyboardLayout.autoDetect' }, 'Auto Detect'),
				description: requested === 'autodetect' ? localize({ bundle: 'ash.workbench', key: 'keyboardLayout.current' }, 'Current: {0}', current.label) : undefined,
			},
			...(userLayout.available ? [{
				kind: 'configure' as const,
				label: localize({ bundle: 'ash.workbench', key: 'keyboardLayout.configureLayoutFile' }, 'Configure Keyboard Layout File'),
				description: localize({ bundle: 'ash.workbench', key: 'keyboardLayout.openLayoutFile' }, 'Open profile keyboard-layout.json'),
			}] : []),
			...layouts.map((layout): LayoutQuickPickItem => ({
				kind: 'layout',
				layout,
				label: layout.label,
				description: requested === layout.id
					? localize({ bundle: 'ash.workbench', key: 'keyboardLayout.selected' }, '{0} · Selected', layoutSourceLabel(layout))
					: layoutSourceLabel(layout),
				detail: layout.id,
			})),
		];
		disposables.add(picker.onDidAccept((item) => {
			picker.hide();
			if (item.kind === 'autodetect') {
				void configuration.updateValue(KeyboardConfiguration.layout, 'autodetect').catch(reportKeyboardLayoutError);
				return;
			}
			if (item.kind === 'configure') {
				void userLayout.openResource().catch(reportKeyboardLayoutError);
				return;
			}
			if (item.layout) {
				void configuration.updateValue(KeyboardConfiguration.layout, item.layout.id).catch(reportKeyboardLayoutError);
			}
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

registerAction2(class InspectKeyMappingsAction extends Action2 {
	constructor() {
		super({
			id: InspectKeyMappingsCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.InspectKeyMappingsAction' }, 'Developer: Inspect Key Mappings'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IKeyboardLayoutService);
		const contents = [
			localize({ bundle: 'ash.workbench', key: 'keyboardLayout.layoutInfo' }, 'Layout info:'),
			JSON.stringify(service.getCurrentKeyboardLayout(), null, 2),
			'',
			service.getKeyboardMapper().dumpDebugInfo(),
		].join('\n');
		return accessor.get(IEditorService).openEditor({
			resource: URI.parse('untitled:/keyboard-layout-inspect.txt'),
			label: localize({ bundle: 'ash.workbench', key: 'keyboardLayout.layoutTitle' }, 'Keyboard Layout'),
			languageId: 'plaintext',
			readOnly: true,
			initialText: contents,
		});
	}
});

registerAction2(class InspectKeyMappingsJsonAction extends Action2 {
	constructor() {
		super({
			id: InspectKeyMappingsJsonCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.InspectKeyMappingsJsonAction' }, 'Developer: Inspect Key Mappings (JSON)'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IKeyboardLayoutService);
		const contents = `${JSON.stringify({
			layout: service.getCurrentKeyboardLayout(),
			rawMapping: service.getRawKeyboardMapping() ?? {},
		}, null, 2)}\n`;
		return accessor.get(IEditorService).openEditor({
			resource: URI.parse('untitled:/keyboard-layout-inspect.json'),
			label: localize({ bundle: 'ash.workbench', key: 'keyboardLayout.layoutJsonTitle' }, 'Keyboard Layout (JSON)'),
			languageId: 'json',
			readOnly: true,
			initialText: contents,
		});
	}
});

registerAction2(class ToggleKeyboardShortcutsTroubleshootingAction extends Action2 {
	constructor() {
		super({
			id: ToggleKeyboardShortcutsTroubleshootingCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.ToggleKeyboardShortcutsTroubleshootingAction' }, 'Developer: Toggle Keyboard Shortcuts Troubleshooting'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const enabled = accessor.get(IKeyboardShortcutTroubleshootingService).toggle();
		if (enabled) {
			accessor.get(IOutputService).showChannel(KeyboardShortcutsOutputChannelId, {
				focus: 'preserve',
			});
		}
	}
});

registerWorkbenchContribution(
	'workbench.contrib.keyboardShortcutTroubleshooting',
	WorkbenchPhase.BlockRestore,
	(accessor) => {
		const disposables = new DisposableStore();
		const troubleshooting = accessor.get(IKeyboardShortcutTroubleshootingService);
		const channel = disposables.add(accessor.get(IOutputService).createChannel({
			id: KeyboardShortcutsOutputChannelId,
			label: localize({ bundle: 'ash.workbench', key: 'keyboardLayout.shortcutsChannel' }, 'Keyboard Shortcuts'),
			kind: 'log',
			source: 'core',
		}));
		disposables.add(troubleshooting.onDidLog((message) => {
			channel.appendLine({
				severity: 'debug',
				category: 'keybinding',
				text: message,
			});
		}));
		return disposables;
	},
);

function layoutSourceLabel(layout: IKeyboardLayoutInfo): string {
	switch (layout.source) {
		case 'user': return localize({ bundle: 'ash.workbench', key: 'keyboardLayout.userLayout' }, 'User configured layout');
		case 'native': return localize({ bundle: 'ash.workbench', key: 'keyboardLayout.systemLayout' }, 'Detected by operating system');
		case 'browser': return localize({ bundle: 'ash.workbench', key: 'keyboardLayout.browserLayout' }, 'Detected by browser');
		case 'builtin': return localize({ bundle: 'ash.workbench', key: 'keyboardLayout.builtinLayout' }, 'Built in');
		case 'fallback': return localize({ bundle: 'ash.workbench', key: 'keyboardLayout.fallbackLayout' }, 'Fallback');
	}
}

function reportKeyboardLayoutError(error: unknown): void {
	console.error('Keyboard layout action failed', error);
}
