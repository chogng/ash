import {
	type IRuntimeEnvironment,
	operatingSystemFromNodePlatform,
	operatingSystemFromUserAgent,
} from "./environment.js";

export type {
	HostOperatingSystem,
	IRuntimeEnvironment,
	RuntimeKind,
} from "./environment.js";

/** Host operating systems that affect keybinding resolution and labels. */
export enum OperatingSystem {
	Windows = "windows",
	Macintosh = "mac",
	Linux = "linux",
}

interface INodeProcess {
	readonly platform: string;
	readonly arch: string;
	readonly versions?: {
		readonly node?: string;
		readonly electron?: string;
		readonly chrome?: string;
	};
	readonly type?: string;
}

interface IPlatformGlobals {
	readonly process?: INodeProcess;
	readonly ash?: {
		readonly environment?: IRuntimeEnvironment;
	};
	readonly navigator?: {
		readonly userAgent: string;
	};
}

const runtimeGlobal = globalThis as IPlatformGlobals;

function detectEnvironment(): IRuntimeEnvironment {
	const bridgedEnvironment = runtimeGlobal.ash?.environment;
	if (bridgedEnvironment) {
		return {
			runtime: bridgedEnvironment.runtime,
			os: bridgedEnvironment.os,
			arch: bridgedEnvironment.arch,
		};
	}

	const nodeProcess = runtimeGlobal.process;
	if (typeof nodeProcess?.versions?.node === "string") {
		return {
			runtime: typeof nodeProcess.versions.electron === "string"
				? "electron"
				: "node",
			os: operatingSystemFromNodePlatform(nodeProcess.platform),
			arch: nodeProcess.arch,
		};
	}

	if (runtimeGlobal.navigator) {
		return {
			runtime: "web",
			os: operatingSystemFromUserAgent(runtimeGlobal.navigator.userAgent),
		};
	}

	return {
		runtime: "unknown",
		os: "unknown",
	};
}

/** Runtime and host-OS information detected once for the current environment. */
export const environment: Readonly<IRuntimeEnvironment> = Object.freeze(
	detectEnvironment(),
);

export const isWindows = environment.os === "windows";
export const isMacintosh = environment.os === "mac";
export const isLinux = environment.os === "linux";
export const isNative =
	environment.runtime === "electron" || environment.runtime === "node";
export const isWeb = environment.runtime === "web";

/**
 * The host OS used for keyboard shortcut resolution and labels.
 *
 * Unknown environments use Linux semantics, matching VS Code's fallback.
 */
export const operatingSystem = isMacintosh
	? OperatingSystem.Macintosh
	: isWindows
		? OperatingSystem.Windows
		: OperatingSystem.Linux;
