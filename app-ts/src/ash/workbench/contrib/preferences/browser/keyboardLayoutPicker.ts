import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeyboardConfiguration } from '../../../../platform/keyboardLayout/common/keyboardConfiguration.js';
import { IKeyboardLayoutService, type IKeyboardLayoutInfo } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { IUserKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/userKeyboardLayout.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IKeyboardShortcutTroubleshootingService } from '../../../services/keybinding/common/keyboardShortcutTroubleshooting.js';
import { IOutputService } from '../../../services/output/common/outputService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
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
			title: 'Preferences: Change Keyboard Layout',
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

		picker.placeholder = 'Select keyboard layout';
		picker.items = [
			{
				kind: 'autodetect',
				label: 'Auto Detect',
				description: requested === 'autodetect' ? `Current: ${current.label}` : undefined,
			},
			...(userLayout.available ? [{
				kind: 'configure' as const,
				label: 'Configure Keyboard Layout File',
				description: 'Open profile keyboard-layout.json',
			}] : []),
			...layouts.map((layout): LayoutQuickPickItem => ({
				kind: 'layout',
				layout,
				label: layout.label,
				description: `${layoutSourceLabel(layout)}${requested === layout.id ? ' · Selected' : ''}`,
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
			title: 'Developer: Inspect Key Mappings',
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IKeyboardLayoutService);
		const contents = [
			'Layout info:',
			JSON.stringify(service.getCurrentKeyboardLayout(), null, 2),
			'',
			service.getKeyboardMapper().dumpDebugInfo(),
		].join('\n');
		return accessor.get(IEditorService).openEditor({
			resource: URI.parse('untitled:/keyboard-layout-inspect.txt'),
			label: 'Keyboard Layout',
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
			title: 'Developer: Inspect Key Mappings (JSON)',
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
			label: 'Keyboard Layout (JSON)',
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
			title: 'Developer: Toggle Keyboard Shortcuts Troubleshooting',
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
	'workbench.contrib.keyboardLayoutPicker',
	WorkbenchPhase.BlockRestore,
	(accessor) => {
		const disposables = new DisposableStore();
		const keyboardLayouts = accessor.get(IKeyboardLayoutService);
		const commands = accessor.get(ICommandService);
		const statusbar = accessor.get(IStatusbarService);
		const entry = disposables.add(statusbar.addEntry(keyboardLayoutStatusEntry(keyboardLayouts.getCurrentKeyboardLayout(), commands), {
			id: 'ash.status.keyboardLayout',
			alignment: StatusbarAlignment.Right,
			priority: 10,
		}));
		disposables.add(keyboardLayouts.onDidChangeKeyboardLayout(() => {
			entry.update(keyboardLayoutStatusEntry(keyboardLayouts.getCurrentKeyboardLayout(), commands));
		}));
		return disposables;
	},
);

registerWorkbenchContribution(
	'workbench.contrib.keyboardShortcutTroubleshooting',
	WorkbenchPhase.BlockRestore,
	(accessor) => {
		const disposables = new DisposableStore();
		const troubleshooting = accessor.get(IKeyboardShortcutTroubleshootingService);
		const channel = disposables.add(accessor.get(IOutputService).createChannel({
			id: KeyboardShortcutsOutputChannelId,
			label: 'Keyboard Shortcuts',
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

function keyboardLayoutStatusEntry(layout: IKeyboardLayoutInfo, commands: ICommandService) {
	const text = `Layout: ${layout.label}`;
	return {
		text,
		ariaLabel: text,
		tooltip: `Keyboard layout (${layout.source})`,
		run: () => commands.executeCommand(ChangeKeyboardLayoutCommandId),
	};
}

function layoutSourceLabel(layout: IKeyboardLayoutInfo): string {
	switch (layout.source) {
		case 'user': return 'User configured layout';
		case 'native': return 'Detected by operating system';
		case 'browser': return 'Detected by browser';
		case 'builtin': return 'Built in';
		case 'fallback': return 'Fallback';
	}
}

function reportKeyboardLayoutError(error: unknown): void {
	console.error('Keyboard layout action failed', error);
}
