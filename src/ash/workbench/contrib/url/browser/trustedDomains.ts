import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { isURLSafeForTrust } from '../../../../platform/url/common/trustedDomains.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
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
	type TrustChoice = IQuickPickItem & { readonly pattern?: string };
	using store = new DisposableStore();
	const picker = store.add(quickInput.createQuickPick<TrustChoice>());
	picker.sortByLabel = false;
	picker.ariaLabel = picker.placeholder = localize('url.trust.choose', 'Choose which domains to trust');
	const choices: TrustChoice[] = [
		{ label: localize('url.trust.origin', 'Trust {0}', url.origin), pattern: url.origin },
		{
			label: localize('url.trust.all', 'Trust All Domains'),
			detail: localize('url.trust.allDetail', 'Disable confirmation for all web domains.'),
			pattern: '*',
		},
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
		store.add(
			token.onCancellationRequested(() => {
				resolve(undefined);
				picker.hide();
			}),
		);
		store.add(
			picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;
				resolve(item);
				picker.hide();
			}),
		);
		store.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
	if (!selected || token.isCancellationRequested) return false;
	if (!selected.pattern) {
		await editors.openEditor(
			{
				resource: TRUSTED_DOMAINS_URI,
				languageId: 'jsonc',
				label: localize('url.trust.manage', 'Manage Trusted Domains'),
			},
			{ pinned: true },
		);
		return false;
	}
	const content = trustedDomains.content;
	const updated = applyEdits(
		content,
		setProperty(content, [-1], selected.pattern, { insertSpaces: true, tabSize: 2 }),
	);
	await trustedDomains.setTrustedDomains(updated, content);
	return trustedDomains.isValid(resource);
}
