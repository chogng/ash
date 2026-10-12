import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import type { ExtensionManifest } from '../../../services/extensions/common/extensionManifest.js';
import { ITerminalContributionService } from '../../../services/terminal/common/terminal.js';
import { isValidTerminalProfileContribution, TerminalContributionService } from './terminalExtensionPoints.js';

ExtensionsRegistry.registerExtensionPoint<ExtensionManifest['contributes']['terminalProfiles']>({
	extensionPoint: 'terminalProfiles',
	validate: value => {
		if (!Array.isArray(value) || value.length > 128) throw invalid();
		const ids = new Set<string>();
		return Object.freeze(value.map(profile => {
			if (!isValidTerminalProfileContribution(profile) || ids.has(profile.id)) throw invalid();
			ids.add(profile.id);
			return Object.freeze({ id: profile.id, title: profile.title, icon: profile.icon, color: profile.color });
		}));
	},
});

registerSingleton(ITerminalContributionService, TerminalContributionService, InstantiationType.Delayed);

function invalid(): TypeError {
	return new TypeError(localize('terminal.profile.invalidDeclaration', 'Invalid terminal profile contribution.'));
}
