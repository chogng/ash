import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import {
	IBrowserViewService,
	BrowserViewStorageScope,
} from '../../../../../platform/browserView/common/browserView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';

for (const scope of Object.values(BrowserViewStorageScope)) {
	const scopeLabel = {
		[BrowserViewStorageScope.Global]: localize({ bundle: 'ash.workbench', key: 'browser.storageGlobal' }, 'Global'),
		[BrowserViewStorageScope.Workspace]: localize(
			{ bundle: 'ash.workbench', key: 'browser.storageWorkspace' },
			'Workspace',
		),
		[BrowserViewStorageScope.Ephemeral]: localize(
			{ bundle: 'ash.workbench', key: 'browser.storageEphemeral' },
			'Ephemeral',
		),
		[BrowserViewStorageScope.Agent]: localize({ bundle: 'ash.workbench', key: 'browser.storageAgent' }, 'Agent'),
	}[scope];
	registerAction2(
		class ClearBrowserStorageAction extends Action2 {
			constructor() {
				super({
					id: `workbench.action.browser.clear${scope[0]!.toUpperCase() + scope.slice(1)}Storage`,
					title: localize2(
						{ bundle: 'ash.workbench', key: 'browser.clearStorageCommand' },
						'Browser: Clear {0} Storage',
						scopeLabel,
					),
					f1: true,
				});
			}
			public override async run(accessor: ServicesAccessor): Promise<void> {
				const editors = accessor.get(IEditorService);
				const pages = accessor.get(IBrowserViewService);
				const dialogs = accessor.get(IDialogService);
				const input = editors.activeEditor;
				if (!(input instanceof BrowserEditorInput) || input.model?.info.session.scope !== scope) {
					return;
				}
				const answer = await dialogs.prompt<boolean>({
					title: localize(
						{ bundle: 'ash.workbench', key: 'browser.clearStorageTitle' },
						'Clear browser data',
					),
					message: localize(
						{ bundle: 'ash.workbench', key: 'browser.clearStorageMessage' },
						'Clear cookies, website storage, cache and permission decisions for every page using this browser storage session?',
					),
					buttons: [
						{
							label: localize({ bundle: 'ash.workbench', key: 'browser.clearStorage' }, 'Clear data'),
							run: () => true,
						},
					],
					cancelButton: localize({ bundle: 'ash.workbench', key: 'browser.cancel' }, 'Cancel'),
				});
				if (answer.result && !input.isDisposed && editors.activeEditor === input) {
					await pages.clearStorage(input.id);
				}
			}
		},
	);
}

import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions,
	ConfigurationScope,
	type IConfigurationRegistry,
} from '../../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'workbench.browser.dataStorage',
	defaultValue: 'default',
	scope: ConfigurationScope.WINDOW,
	parse: value => {
		if (typeof value !== 'string' || !['default', 'global', 'workspace', 'ephemeral'].includes(value)) {
			throw new TypeError('Invalid browser storage scope');
		}
		return value;
	},
	setting: {
		valueType: 'select',
		get title() {
			return localize({ bundle: 'ash.workbench', key: 'browser.storageSetting' }, 'Browser data storage');
		},
		get description() {
			return localize(
				{ bundle: 'ash.workbench', key: 'browser.storageDescription' },
				'Choose storage for new user pages. Default uses global storage locally and workspace storage remotely. Untrusted workspaces use ephemeral storage. Agent pages keep their isolated Thread storage.',
			);
		},
		options: [
			{
				value: 'default',
				get label() {
					return localize({ bundle: 'ash.workbench', key: 'browser.storageDefault' }, 'Default');
				},
			},
			{
				value: 'global',
				get label() {
					return localize({ bundle: 'ash.workbench', key: 'browser.storageGlobal' }, 'Global');
				},
			},
			{
				value: 'workspace',
				get label() {
					return localize({ bundle: 'ash.workbench', key: 'browser.storageWorkspace' }, 'Workspace');
				},
			},
			{
				value: 'ephemeral',
				get label() {
					return localize({ bundle: 'ash.workbench', key: 'browser.storageEphemeral' }, 'Ephemeral');
				},
			},
		],
	},
});
