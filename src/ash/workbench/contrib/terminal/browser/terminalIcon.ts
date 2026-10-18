import type { Icon } from "../../../../base/common/icon.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import type { ITerminalProfile } from "./terminal.js";

/** Selects the product icon for a trusted terminal profile identity. */
export function terminalProfileIcon(profile: Pick<ITerminalProfile, "profileId" | "icon"> | undefined): Icon {
	if (profile?.icon && getLxiconDefinition(profile.icon.id)) return profile.icon;
	switch (profile?.profileId) {
		case "powershell":
		case "windows-powershell":
		case "pwsh":
			return Lxicon.terminalPowershell;
		case "cmd":
		case "command-prompt":
			return Lxicon.terminalCmd;
		case "git-bash":
			return Lxicon.terminalGitBash;
		default:
			return Lxicon.terminal;
	}
}
