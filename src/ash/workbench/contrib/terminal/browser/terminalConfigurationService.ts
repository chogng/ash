import '../common/terminalConfiguration.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type ITerminalConfiguration, TERMINAL_CONFIG_SECTION } from '../common/terminal.js';
import { EDITOR_FONT_DEFAULTS } from '../../../../editor/common/config/fontInfo.js';
import type { ITerminalConfigurationService } from './terminal.js';

/** Derives screen options from the configuration system's validated effective values. */
export class TerminalConfigurationService extends Disposable implements ITerminalConfigurationService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onConfigChanged = this.changed.event;

	constructor(@IConfigurationService private readonly configuration: IConfigurationService) {
		super();
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (
					event.affectsConfiguration(TERMINAL_CONFIG_SECTION) ||
					event.affectsConfiguration('editor.fontFamily')
				)
					this.changed.fire();
			}),
		);
	}

	get config(): Readonly<ITerminalConfiguration> {
		const settings = this.configuration.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
		const fontFamily =
			settings.fontFamily ||
			this.configuration.getValue<string>('editor.fontFamily') ||
			EDITOR_FONT_DEFAULTS.fontFamily;
		// A user-selected face may not exist on this host. Keep terminal cells monospaced.
		return Object.freeze({
			...settings,
			fontFamily: /(?:^|,)\s*monospace\s*(?:,|$)/i.test(fontFamily) ? fontFamily : `${fontFamily}, monospace`,
		});
	}
}
