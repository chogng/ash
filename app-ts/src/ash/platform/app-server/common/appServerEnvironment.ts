const COMMON_HOST_ENVIRONMENT_KEYS = ["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"] as const;
const POSIX_HOST_ENVIRONMENT_KEYS = ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"] as const;
const WINDOWS_HOST_ENVIRONMENT_KEYS = ["ALLUSERSPROFILE", "APPDATA", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PSMODULEPATH", "PUBLIC", "SYSTEMDRIVE", "SYSTEMROOT", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"] as const;
const PRODUCT_ENVIRONMENT_KEYS = ["ASH_APP_SERVER_PATH", "ASH_APP_SERVER_SHA256", "ASH_ELECTRON_RUN_AS_NODE_PATH", "ASH_PRODUCT_SERVICES_PATH", "ASH_HOME", "ASH_RG_PATH", "ASH_WORKSPACE_ROOT", "ASH_DIR_GRANT_SOURCE"] as const;
const ALL_HOST_ENVIRONMENT_KEYS = new Set<string>([...COMMON_HOST_ENVIRONMENT_KEYS, ...POSIX_HOST_ENVIRONMENT_KEYS, ...WINDOWS_HOST_ENVIRONMENT_KEYS]);
const ALL_PRODUCT_ENVIRONMENT_KEYS = new Set<string>(PRODUCT_ENVIRONMENT_KEYS);

export type AppServerHostPlatform = "posix" | "windows";

/** Whether a variable may cross the Electron Main to App Server process boundary. */
export function isAllowedAppServerEnvironmentKey(key: string): boolean {
	const normalized = key.toUpperCase();
	return ALL_HOST_ENVIRONMENT_KEYS.has(normalized) || ALL_PRODUCT_ENVIRONMENT_KEYS.has(normalized) || normalized.startsWith("LC_");
}

/** Builds the explicit, secret-excluding environment supplied to the local App Server process. */
export function buildAppServerEnvironment(source: Readonly<Record<string, string | undefined>>, platform: AppServerHostPlatform, productEnvironment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	const hostKeys = platform === "windows" ? [...COMMON_HOST_ENVIRONMENT_KEYS, ...WINDOWS_HOST_ENVIRONMENT_KEYS] : [...COMMON_HOST_ENVIRONMENT_KEYS, ...POSIX_HOST_ENVIRONMENT_KEYS];
	for (const key of hostKeys) {
		const value = environmentValue(source, key, platform);
		if (isValidEnvironmentValue(value)) result[key] = value;
	}
	for (const [key, value] of Object.entries(source)) {
		if (!key.toUpperCase().startsWith("LC_") || !isValidEnvironmentName(key) || !isValidEnvironmentValue(value)) continue;
		result[platform === "windows" ? key.toUpperCase() : key] = value;
	}
	for (const [key, value] of Object.entries(productEnvironment)) {
		const normalized = key.toUpperCase();
		if (!ALL_PRODUCT_ENVIRONMENT_KEYS.has(normalized) || !isValidEnvironmentValue(value)) {
			throw new Error(`Invalid App Server product environment variable: ${key}`);
		}
		result[normalized] = value;
	}
	return result;
}

function environmentValue(source: Readonly<Record<string, string | undefined>>, key: string, platform: AppServerHostPlatform): string | undefined {
	if (platform === "posix") return source[key];
	const entry = Object.entries(source).find(([candidate]) => candidate.toUpperCase() === key);
	return entry?.[1];
}

function isValidEnvironmentName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

function isValidEnvironmentValue(value: string | undefined): value is string {
	return value !== undefined && !value.includes("\0");
}
