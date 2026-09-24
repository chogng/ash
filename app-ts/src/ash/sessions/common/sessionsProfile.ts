import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";

/**
 * Identity and navigation contract for one dedicated Sessions workbench.
 *
 * A Sessions workbench is a mode-owned surface beside the regular
 * Workbench. It may use reusable Workbench contributions but must never
 * become a default Workbench layout variant.
 */
export interface SessionsProfile {
	readonly id: string;
	readonly modeId: WorkbenchModeId;
	readonly label: string;
	readonly titlebarActionId: string;
	readonly workbenchRelativePath: string;
}

/** Creates an immutable Sessions profile after checking stable mode identity. */
export function createSessionsProfile(profile: SessionsProfile): SessionsProfile {
	if (!profile || typeof profile !== "object") throw new TypeError("Sessions profile is required");
	if (typeof profile.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(profile.id)) throw new TypeError("Sessions profile id must be stable kebab-case");
	if (typeof profile.modeId !== "string" || !/^[a-z][a-z0-9-]*$/.test(profile.modeId)) throw new TypeError("Sessions profile mode id must be stable kebab-case");
	if (typeof profile.label !== "string" || profile.label.trim().length === 0) throw new TypeError("Sessions profile label must not be empty");
	if (typeof profile.titlebarActionId !== "string" || !/^[a-z][a-z0-9.-]*$/.test(profile.titlebarActionId)) throw new TypeError("Sessions titlebar action id must be stable");
	if (typeof profile.workbenchRelativePath !== "string" || !profile.workbenchRelativePath.startsWith("../workbench/")) throw new TypeError("Sessions profile must navigate back to its sibling Workbench page");
	return Object.freeze({ ...profile });
}
