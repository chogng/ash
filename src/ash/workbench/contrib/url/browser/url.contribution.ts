import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import {
	IInstantiationService,
	type ServicesAccessor,
} from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITrustedDomainService } from '../common/trustedDomainService.js';
import { TrustedDomainService } from './trustedDomainService.js';
import { OpenerValidatorContributions } from './trustedDomainsValidator.js';
import { TRUSTED_DOMAINS_URI } from './trustedDomains.js';
import { TrustedDomainsFileSystemProvider } from './trustedDomainsFileSystemProvider.js';

registerSingleton(ITrustedDomainService, TrustedDomainService, InstantiationType.Delayed);
registerWorkbenchContribution('workbench.contrib.url', WorkbenchPhase.BlockRestore, accessor => {
	const store = new DisposableStore();
	try {
		const instantiation = accessor.get(IInstantiationService);
		store.add(instantiation.createInstance(TrustedDomainsFileSystemProvider));
		store.add(instantiation.createInstance(OpenerValidatorContributions));
		return store;
	} catch (error) {
		store.dispose();
		throw error;
	}
});

registerAction2(
	class ManageTrustedDomainsAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.manageTrustedDomain',
				title: localize2('url.trust.manage', 'Manage Trusted Domains'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor
				.get(IEditorService)
				.openEditor(
					{
						resource: TRUSTED_DOMAINS_URI,
						languageId: 'jsonc',
						label: localize('url.trust.manage', 'Manage Trusted Domains'),
					},
					{ pinned: true },
				);
		}
	},
);

registerAction2(
	class OpenURLAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.url.openUrl', title: localize2('url.open.title', 'Open URL'), f1: true });
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const input = accessor.get(IQuickInputService);
			const storage = accessor.get(IStorageService);
			const opener = accessor.get(IOpenerService);
			const key = 'workbench.action.url.openUrl.lastInput';
			const target = await input.input({
				title: localize('url.open.prompt', 'URL to Open'),
				value: storage.get(key, StorageScope.WORKSPACE, ''),
			});
			if (!target) return;
			storage.store(key, target, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			await opener.open(target, { allowContributedOpeners: true });
		}
	},
);
