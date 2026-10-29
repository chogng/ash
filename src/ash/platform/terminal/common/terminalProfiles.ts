import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import type { IExtensionTerminalProfile, ITerminalProfile, TerminalArguments, TerminalIcon } from './terminal.js';

/** Schema candidates are suggestions; unavailable persisted names retain their fallback semantics. */
export function createProfileSchemaEnums(
	detectedProfiles: readonly ITerminalProfile[],
	extensionProfiles?: readonly IExtensionTerminalProfile[],
): { values: (string | null)[]; markdownDescriptions: string[] } {
	const values: (string | null)[] = [null];
	const markdownDescriptions = [localize('terminalAutomaticProfile', 'Automatically detect the default')];
	for (const profile of detectedProfiles) {
		if (values.includes(profile.profileName)) continue;
		values.push(profile.profileName);
		markdownDescriptions.push(
			`$(${profile.icon?.id ?? 'terminal'}) ${profile.profileName}\n\n\`\`\`json\n${JSON.stringify({ path: profile.path, args: profile.args, env: profile.env, overrideName: profile.overrideName, color: profile.color }, null, 2)}\n\`\`\``,
		);
	}
	for (const profile of extensionProfiles ?? []) {
		if (values.includes(profile.title)) continue;
		values.push(profile.title);
		markdownDescriptions.push(`$(${profile.options?.icon?.id ?? 'terminal'}) ${profile.title}\n\n\`${profile.extensionIdentifier}\``);
	}
	return { values, markdownDescriptions };
}

export function terminalProfileArgsMatch(a: TerminalArguments | undefined, b: TerminalArguments | undefined): boolean {
	if (a === b) return true;
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}

export function terminalIconsEqual(a?: TerminalIcon, b?: TerminalIcon): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (ThemeIcon.isThemeIcon(a) && ThemeIcon.isThemeIcon(b)) return ThemeIcon.isEqual(a, b);
	if (a instanceof URI && b instanceof URI) return a.toString() === b.toString();
	if ('light' in a && 'light' in b) return a.light.toString() === b.light.toString() && a.dark.toString() === b.dark.toString();
	return false;
}
