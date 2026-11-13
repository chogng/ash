import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { ChatConfiguration } from '../../chat/common/constants.js';
import './screenshotToolConfiguration.js';
import { IScreenshotToolService } from './screenshotTool.js';
import { readCodeImageSelection } from '../../../services/imageEditor/browser/imageEditorSelection.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorSemanticHighlightingConfiguration } from '../../../../editor/common/config/editorConfigurationSchema.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Action2, registerAction2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { localize2 } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<boolean>({
	key: ChatConfiguration.AppWindowScreenshotsEnabled,
	defaultValue: true,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('chat.appWindowScreenshots.invalid', 'The app window screenshot setting must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('chat.appWindowScreenshots.title', 'App window screenshots'); },
		get description() { return localize('chat.appWindowScreenshots.description', 'Capture and annotate another app window before attaching it to Chat.'); },
	},
});


registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'snapshot.code', title: localize2('screenshot.builtin.code.command', 'Screenshot: Create Code Image'), f1: true,
			precondition: ContextKeyExpr.has('editorHasSelection'),
			menu: { id: MenuId.EditorContext, when: ContextKeyExpr.has('editorHasSelection'), group: 'z_chat', order: 2 },
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditors = accessor.get(ICodeEditorService);
		const theme = accessor.get(IThemeService);
		const configuration = accessor.get(IConfigurationService);
		const editors = accessor.get(IScreenshotToolService);
		const signal = new AbortController().signal;
		const code = await readCodeImageSelection(codeEditors.getActiveCodeEditor(), theme.getColorTheme(), configuration.getValue<boolean | 'configuredByTheme'>(EditorSemanticHighlightingConfiguration), signal);
		await editors.show({ code }, signal);
	}
});
