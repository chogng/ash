import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { isURLSafeForTrust } from '../../../../platform/url/common/trustedDomains.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IBoundStringArraySetting } from '../../../services/preferences/common/preferences.js';
import type { ITrustedDomainService } from '../common/trustedDomainService.js';

export const TRUSTED_DOMAINS_URI = URI.parse('trustedDomains:/Trusted Domains');

export async function configureOpenerTrustedDomainsHandler(
	resource: URI,
	trustedDomains: ITrustedDomainService,
	quickInput: IQuickInputService,
	editors: IEditorService,
	token: CancellationToken,
): Promise<boolean> {
	if (token.isCancellationRequested || !isURLSafeForTrust(resource)) return false;
	const url = new URL(resource.toString());
	type TrustChoice = IQuickPickItem & { readonly pattern?: string; };
	using store = new DisposableStore();
	const picker = store.add(quickInput.createQuickPick<TrustChoice>());
	picker.sortByLabel = false;
	picker.ariaLabel = picker.placeholder = localize('url.trust.choose', 'Choose which domains to trust');
	const choices: TrustChoice[] = [
		{ label: localize('url.trust.origin', 'Trust {0}', url.origin), pattern: url.origin },
		{ label: localize('url.trust.all', 'Trust All Domains'), detail: localize('url.trust.allDetail', 'Disable confirmation for all web domains.'), pattern: '*' },
		{ label: localize('url.trust.manage', 'Manage Trusted Domains') },
	];
	if (!url.hostname.startsWith('[') && !/^[\d.]+$/u.test(url.hostname)) {
		choices.splice(1, 0, {
			label: localize('url.trust.subdomains', 'Trust {0} and its subdomains', url.hostname),
			pattern: `${url.protocol}//*.${url.host}`,
		});
	}
	picker.items = choices;
	const selected = await new Promise<TrustChoice | undefined>(resolve => {
		store.add(token.onCancellationRequested(() => { resolve(undefined); picker.hide(); }));
		store.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			resolve(item); picker.hide();
		}));
		store.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
	if (!selected || token.isCancellationRequested) return false;
	if (!selected.pattern) {
		await editors.openEditor({ resource: TRUSTED_DOMAINS_URI, languageId: 'jsonc', label: localize('url.trust.manage', 'Manage Trusted Domains') }, { pinned: true });
		return false;
	}
	await trustedDomains.addTrustedDomain(selected.pattern);
	return trustedDomains.isValid(resource);
}

export const TRUSTED_DOMAINS_SETTING_ID = 'workbench.trustedDomains';

export function trustedDomainsSetting(domains: ITrustedDomainService): IBoundStringArraySetting {
	return {
		id: TRUSTED_DOMAINS_SETTING_ID,
		valueType: 'array',
		keywords: ['trusted domains', 'external links', 'link protection'],
		get title() {
			return localize({ bundle: 'ash.settings', key: 'trustedDomains.title' }, 'Trusted domains');
		},
		get description() {
			return localize({ bundle: 'ash.settings', key: 'trustedDomains.description' }, 'Add your own rules to open matching external links without confirmation.');
		},
		accessibility: {
			verbositySetting: AccessibilityVerbositySettingId.TrustedDomainsSettings,
			help: localize({ bundle: 'ash.settings', key: 'trustedDomains.help' }, 'Your trusted domain rules apply immediately. Use Tab to reach Add Domain and the Edit and Remove actions for each rule. Activate Edit or double-click a rule to edit it in place. Press Enter to save or Escape to cancel. The Manage Trusted Domains command opens your rules as JSONC and lists the product defaults in comments.'),
		},
		columnLabel: localize({ bundle: 'ash.settings', key: 'trustedDomains.rule' }, 'Domain rule'),
		inputLabel: localize({ bundle: 'ash.settings', key: 'trustedDomains.input' }, 'Domain to trust'),
		placeholder: 'https://example.com',
		addLabel: localize({ bundle: 'ash.settings', key: 'trustedDomains.add' }, 'Add Domain'),
		binding: {
			onDidChange: domains.onDidChangeTrustedDomains,
			getValue: () => domains.userTrustedDomains,
			apply: edit => {
				switch (edit.kind) {
					case 'add': return domains.addTrustedDomain(edit.value);
					case 'edit': return domains.updateTrustedDomain(edit.original, edit.value);
					case 'remove': return domains.removeTrustedDomain(edit.original);
				}
			},
		},
	};
}
