import { cancelOnDispose } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { DialogSeverity, IDialogService, type IActionPromptButton } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { isURLSafeForTrust } from '../../../../platform/url/common/trustedDomains.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITrustedDomainService } from '../common/trustedDomainService.js';
import { configureOpenerTrustedDomainsHandler } from './trustedDomains.js';

/** Installs window policy before links can reach host or contributed openers. */
export class OpenerValidatorContributions extends Disposable {
	private readonly token = cancelOnDispose(this._store);
	constructor(
		@IOpenerService opener: IOpenerService,
		@ITrustedDomainService private readonly trustedDomains: ITrustedDomainService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IEditorService private readonly editors: IEditorService,
	) {
		super();
		this._register(opener.registerValidator({ shouldOpen: target => this.validateLink(target) }));
	}

	async validateLink(target: URI | string): Promise<boolean> {
		if (this.isDisposed) return false;
		const resource = typeof target === 'string' ? URI.parse(target) : target;
		if (resource.scheme.toLowerCase() !== 'http' && resource.scheme.toLowerCase() !== 'https') return true;
		if (this.trustedDomains.isValid(resource)) return true;
		const buttons: IActionPromptButton<boolean>[] = [
			{ label: localize('url.trust.open', 'Open'), run: () => !this.isDisposed },
			{ label: localize('url.trust.copy', 'Copy'), run: async () => { await this.clipboard.writeText(typeof target === 'string' ? target : target.toString()); return false; } },
		];
		if (isURLSafeForTrust(resource)) {
			buttons.push({
				label: localize('url.trust.configure', 'Configure Trusted Domains'),
				run: () => configureOpenerTrustedDomainsHandler(resource, this.trustedDomains, this.quickInput, this.editors, this.token),
			});
		}
		const decision = await this.dialogs.prompt({
			severity: DialogSeverity.Info,
			title: localize('url.trust.title', 'Open External Link'),
			message: localize('url.trust.message', 'Do you want to open this external website?'),
			detail: typeof target === 'string' ? target : target.toString(),
			buttons,
			cancelButton: localize('url.trust.cancel', 'Cancel'),
		});
		return !this.isDisposed && decision.result === true;
	}
}
