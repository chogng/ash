import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

export const LanguageServerLifecycleConfiguration = {
	autoSuspend: 'languageServers.autoSuspend',
	idleTimeoutMinutes: 'languageServers.idleTimeoutMinutes',
} as const;

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
registry.registerConfiguration({
	// Retain computed analysis between visits; releasing the process loses its in-memory cache.
	key: LanguageServerLifecycleConfiguration.autoSuspend, defaultValue: false, scope: ConfigurationScope.APPLICATION,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize({ bundle: 'ash.settings', key: 'lsp.idle.invalidEnabled' }, 'Automatic language server release must be true or false.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.settings', key: 'lsp.idle.enabledTitle' }, 'Release idle language servers'); },
		get description() { return localize({ bundle: 'ash.settings', key: 'lsp.idle.enabledDescription' }, 'Release a language server after its last file closes and the waiting time passes. Off by default to retain computed analysis in memory for your next visit. Turning this on frees process memory, but language features may be slower after the server restarts. Matching open files keep the server running. Basic highlighting and folding remain available.'); },
	},
});
registry.registerConfiguration({
	key: LanguageServerLifecycleConfiguration.idleTimeoutMinutes, defaultValue: 10, scope: ConfigurationScope.APPLICATION,
	parse(value: unknown): number {
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120) throw new TypeError(localize({ bundle: 'ash.settings', key: 'lsp.idle.invalidMinutes' }, 'The idle waiting time must be a whole number from 1 to 120 minutes.'));
		return value;
	},
	setting: {
		valueType: 'number', minimum: 1, maximum: 120,
		get title() { return localize({ bundle: 'ash.settings', key: 'lsp.idle.minutesTitle' }, 'Idle waiting time (minutes)'); },
		get description() { return localize({ bundle: 'ash.settings', key: 'lsp.idle.minutesDescription' }, 'Wait this long after the last matching file closes before releasing its language server. Reopening a file cancels the wait. Applies when automatic release is enabled.'); },
	},
});

/** Editor-owned eligibility and activity leases for connection-local LSP processes. */
export interface ILanguageServerLifecycleService {
	start(): void;
	withActivity<T>(document: { readonly dirId?: string; readonly languageId: string; }, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
}

export const ILanguageServerLifecycleService = createServiceIdentifier<ILanguageServerLifecycleService>('languageServerLifecycleService');
