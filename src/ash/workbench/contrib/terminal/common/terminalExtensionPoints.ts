import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import type { IExtensionTerminalProfile } from '../../../../platform/terminal/common/terminal.js';
import { IExtensionService, type ExtensionManifest } from '../../../services/extensions/common/extensionService.js';
import type { ITerminalContributionService } from './terminal.js';

type TerminalProfileContribution = ExtensionManifest['contributes']['terminal']['profiles'][number];

/** Terminal-domain declarations derived from the extension owner's committed, validated manifests. */
export class TerminalContributionService extends Disposable implements ITerminalContributionService {
	private profiles: readonly IExtensionTerminalProfile[] = [];
	private readonly changed = this._register(new Emitter<readonly IExtensionTerminalProfile[]>());
	readonly onDidChangeTerminalProfiles = this.changed.event;
	get terminalProfiles(): readonly IExtensionTerminalProfile[] { return this.profiles; }

	constructor(@IExtensionService private readonly extensions: IExtensionService) {
		super();
		this.update();
		this._register(extensions.onDidChange(() => this.update()));
	}

	private update(): void {
		this.profiles = Object.freeze(this.extensions.getExtensionPointContributions<ExtensionManifest['contributes']['terminal']>('terminal').flatMap(user => user.value.profiles.map(profile => Object.freeze({
			extensionIdentifier: user.description.id,
			id: profile.id,
			title: profile.title,
			options: Object.freeze({ icon: profile.icon ? ThemeIcon.fromId(profile.icon) : undefined, color: profile.color }),
		}))));
		this.changed.fire(this.profiles);
	}

	protected override disposeCore(): void {
		this.profiles = [];
		super.disposeCore();
	}
}

/** The declaration boundary is shared by schema registration and manifest decoding. */
export function isValidTerminalProfileContribution(value: unknown): value is TerminalProfileContribution {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const profile = value as Record<string, unknown>;
	return typeof profile.id === 'string' && /^[\w.-]{1,256}$/.test(profile.id)
		&& typeof profile.title === 'string' && !!profile.title.trim() && profile.title.length <= 256 && !/[\u0000-\u001f\u007f]/.test(profile.title)
		&& (profile.icon === undefined || typeof profile.icon === 'string' && /^[\w-]{1,256}$/.test(profile.icon))
		&& (profile.color === undefined || typeof profile.color === 'string' && /^[\w.]{1,256}$/.test(profile.color));
}
