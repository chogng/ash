const PRODUCT_ENVIRONMENT_KEYS = ["ASH_DEV_RUNTIME_ROOT", "ASH_APP_SERVER_PATH", "ASH_APP_SERVER_SHA256", "ASH_APP_SERVER_CONNECTION_ROLE", "ASH_ELECTRON_RUN_AS_NODE_PATH", "ASH_PRODUCT_SERVICES_PATH", "ASH_HOME", "ASH_RG_PATH", "ASH_SSH_PATH", "ASH_WORKSPACE_ROOT", "ASH_DIR_GRANT_SOURCE", "ASH_REMOTE_HOST", "ASH_REMOTE_ROOT", "ASH_REMOTE_RUNTIME"] as const;
// Match the process boundary in exec-server: developer credentials stay usable,
// while launcher authentication cannot pass to developer or extension child processes.
const PRIVATE_HOST_ENVIRONMENT_KEYS = new Set([
	"CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN", "NODE_REPL_AUTH_TOKEN", "CODEX_GUARDIAN_DECISIONS_API_KEY",
	"OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
]);
const ALL_PRODUCT_ENVIRONMENT_KEYS = new Set<string>(PRODUCT_ENVIRONMENT_KEYS);

export type AppServerHostPlatform = "macos" | "linux" | "windows";
export type AppServerLaunchMode = "desktop" | "web";

/** Whether a variable may cross the Electron Main to App Server process boundary. */
export function isAllowedAppServerEnvironmentKey(key: string): boolean {
	const normalized = key.toUpperCase();
	return isValidEnvironmentName(key) && !PRIVATE_HOST_ENVIRONMENT_KEYS.has(normalized) && !normalized.startsWith("ELECTRON_");
}

/** Builds the developer environment supplied to the local App Server process. */
export function buildAppServerEnvironment(source: Readonly<Record<string, string | undefined>>, platform: AppServerHostPlatform, productEnvironment: Readonly<Record<string, string>>, _launchMode: AppServerLaunchMode): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (!isAllowedAppServerEnvironmentKey(key) || !isValidEnvironmentValue(value)) continue;
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

function isValidEnvironmentName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

function isValidEnvironmentValue(value: string | undefined): value is string {
	return value !== undefined && !value.includes("\0");
}
