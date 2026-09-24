/** Execution hosts supported by the desktop codebase. */
export type RuntimeKind = "electron" | "node" | "web" | "unknown";

/** Host operating systems with dedicated workbench behavior. */
export type HostOperatingSystem = "windows" | "mac" | "linux" | "unknown";

/**
 * Immutable runtime metadata captured before the workbench starts.
 *
 * Native hosts must provide normalized values at their trust boundary. Web
 * hosts derive the same contract from browser metadata.
 */
export interface IRuntimeEnvironment {
	readonly runtime: RuntimeKind;
	readonly os: HostOperatingSystem;
	readonly arch?: string;
}

/** @internal */
export function operatingSystemFromNodePlatform(
	platform: string,
): HostOperatingSystem {
	switch (platform) {
		case "win32":
			return "windows";
		case "darwin":
			return "mac";
		case "linux":
			return "linux";
		default:
			return "unknown";
	}
}

/** @internal */
export function operatingSystemFromUserAgent(
	userAgent: string,
): HostOperatingSystem {
	if (userAgent.includes("Windows")) return "windows";
	if (
		userAgent.includes("Macintosh")
		|| userAgent.includes("iPhone")
		|| userAgent.includes("iPad")
	) {
		return "mac";
	}
	if (userAgent.includes("Linux")) return "linux";
	return "unknown";
}
