import type { Icon } from "../../../../../base/common/icon.js";
import { lxiconsLibrary } from "../../../../../base/common/lxiconsLibrary.js";
import type { ITerminalProfile } from "../../../../services/terminal/common/terminal.js";

/** Selects the product icon for a trusted terminal profile identity. */
export function terminalProfileIcon(profile: Pick<ITerminalProfile, "profileId"> | undefined): Icon {
	switch (profile?.profileId) {
		case "cmd":
		case "command-prompt":
			return lxiconsLibrary.terminalCmd;
		case "git-bash":
			return lxiconsLibrary.terminalGitBash;
		default:
			return lxiconsLibrary.terminal;
	}
}
