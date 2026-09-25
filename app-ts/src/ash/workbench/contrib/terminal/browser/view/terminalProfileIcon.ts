import type { Icon } from "../../../../../base/common/icon.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import type { ITerminalProfile } from "../../../../services/terminal/common/terminal.js";

/** Selects the product icon for a trusted terminal profile identity. */
export function terminalProfileIcon(profile: Pick<ITerminalProfile, "profileId"> | undefined): Icon {
	switch (profile?.profileId) {
		case "cmd":
		case "command-prompt":
			return Lxicon.terminalCmd;
		case "git-bash":
			return Lxicon.terminalGitBash;
		default:
			return Lxicon.terminal;
	}
}
