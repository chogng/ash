import { Event } from '../../../../base/common/event.js';
import type { ConfigurationTarget, IConfigurationOverrides, IConfigurationUpdateOptions, IConfigurationUpdateOverrides, IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { SESSIONS_DIFF_VIEW_MODE, SESSIONS_DIFF_WORD_WRAP, SESSIONS_EDITOR_WORD_WRAP, SESSIONS_TERMINAL_CONFIG_SECTION } from '../../../common/configuration.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { WorkspaceService, type WorkspaceServiceOptions } from '../../../../workbench/services/configuration/browser/configurationService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { TERMINAL_CONFIG_SECTION } from '../../../../workbench/contrib/terminal/common/terminal.js';

const editorOverrides: ReadonlyMap<string, string> = new Map([
	['diffEditor.renderSideBySide', SESSIONS_DIFF_VIEW_MODE],
	['diffEditor.useInlineViewWhenSpaceIsLimited', SESSIONS_DIFF_VIEW_MODE],
	['diffEditor.wordWrap', SESSIONS_DIFF_WORD_WRAP],
	['editor.wordWrap', SESSIONS_EDITOR_WORD_WRAP],
]);

function isTerminalSection(section: string): boolean {
	return section === TERMINAL_CONFIG_SECTION || section.startsWith(`${TERMINAL_CONFIG_SECTION}.`);
}

function terminalSettingKey(section: string): string {
	return isTerminalSection(section) ? SESSIONS_TERMINAL_CONFIG_SECTION + section.slice(TERMINAL_CONFIG_SECTION.length) : section;
}

function projectTerminalKeys(keys: Iterable<string>): string[] {
	return [...keys].flatMap(key => {
		if (isTerminalSection(key)) return [];
		return key.startsWith(`${SESSIONS_TERMINAL_CONFIG_SECTION}.`)
			? [key, TERMINAL_CONFIG_SECTION + key.slice(SESSIONS_TERMINAL_CONFIG_SECTION.length)] : [key];
	});
}

/** Resolves Agents Window defaults without changing the shared settings resource. */
export class ConfigurationService extends WorkspaceService {
	override readonly onDidChangeConfiguration = Event.map(this.configurationChanges, event => {
		const keys = [...editorOverrides].filter(([, setting]) => event.affectsConfiguration(setting)).map(([key]) => key);
		return {
			...event,
			affectedKeys: new Set([...projectTerminalKeys(event.affectedKeys), ...keys]),
			change: { ...event.change, keys: [...projectTerminalKeys(event.change.keys), ...keys] },
			affectsConfiguration: (section: string, overrides?: IConfigurationOverrides) =>
				event.affectsConfiguration(terminalSettingKey(section), overrides) || keys.some(key => key === section || key.startsWith(section + '.')),
		};
	});

	override inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<Readonly<T>> {
		return super.inspect(terminalSettingKey(key), overrides);
	}

	override updateValue(key: string, value: unknown, ...args:
		[] | [ConfigurationTarget] | [IConfigurationOverrides | IConfigurationUpdateOverrides]
		| [IConfigurationOverrides | IConfigurationUpdateOverrides, ConfigurationTarget, IConfigurationUpdateOptions?]
	): Promise<void> {
		const scopedKey = terminalSettingKey(key);
		if (args.length === 2 || args.length === 3) return super.updateValue(scopedKey, value, args[0], args[1], args[2]);
		const [target] = args;
		if (typeof target === 'number') return super.updateValue(scopedKey, value, target);
		return target ? super.updateValue(scopedKey, value, target) : super.updateValue(scopedKey, value);
	}

	protected override resolveSection(section: string, overrides?: IConfigurationOverrides): unknown {
		const setting = editorOverrides.get(section);
		const value = setting && super.resolveSection(setting, overrides);
		if (value !== undefined && value !== 'inherit') {
			if (section === 'diffEditor.renderSideBySide') return value !== 'inline';
			if (section === 'diffEditor.useInlineViewWhenSpaceIsLimited') return value === 'automatic';
			return value;
		}
		return super.resolveSection(terminalSettingKey(section), overrides);
	}

	constructor(
		options: Omit<WorkspaceServiceOptions, 'defaults' | 'readOnlyKeys'> = {},
		@IFileService files: IFileService,
		@ILogService log: ILogService,
		@IUserDataProfileService profile: IUserDataProfileService,
	) {
		super(options, files, log, profile);
	}

	protected override defaultValue(configuration: IRegisteredConfiguration): unknown {
		return configuration.agentsWindow ? configuration.agentsWindow.default : super.defaultValue(configuration);
	}

	protected override isReadOnly(key: string): boolean {
		// Resolve current registrations so extension reloads cannot leave stale window rules.
		return this.registry.getConfiguration(key)?.agentsWindow?.readOnly === true;
	}
}
