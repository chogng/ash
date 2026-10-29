import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import type { ExtensionManifest } from '../../../services/extensions/common/extensionManifest.js';
import { ITerminalContributionService } from './terminal.js';
import { isValidTerminalProfileContribution, TerminalContributionService } from './terminalExtensionPoints.js';

ExtensionsRegistry.registerExtensionPoint<ExtensionManifest['contributes']['terminal']>({
	extensionPoint: 'terminal',
	validate: value => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
		const profiles = (value as Record<string, unknown>).profiles;
		if (!Array.isArray(profiles) || profiles.length > 128) throw invalid();
		const ids = new Set<string>();
		return Object.freeze({
			profiles: Object.freeze(
				profiles.map(profile => {
					if (!isValidTerminalProfileContribution(profile) || ids.has(profile.id)) throw invalid();
					ids.add(profile.id);
					return Object.freeze({
						id: profile.id,
						title: profile.title,
						icon: profile.icon,
						color: profile.color,
					});
				}),
			),
		});
	},
});

registerSingleton(ITerminalContributionService, TerminalContributionService, InstantiationType.Delayed);

function invalid(): TypeError {
	return new TypeError(localize('terminal.profile.invalidDeclaration', 'Invalid terminal profile contribution.'));
}
