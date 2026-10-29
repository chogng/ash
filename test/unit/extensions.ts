import { runUnitTests } from './mocha.ts';

await runUnitTests(
	[
		'src/ash/base/test/common/event.test.js',
		'src/ash/editor/test/common/languagesRegistry.test.js',
		'src/ash/platform/commands/test/common/commands.test.js',
		'src/ash/platform/extensions/test/**/*.test.js',
		'src/ash/platform/extensionResourceLoader/test/**/*.test.js',
		'src/ash/platform/agentHost/test/browser/extensionHostProtocol.test.js',
		'src/ash/workbench/services/extensions/test/**/*.test.js',

		'src/ash/workbench/contrib/codeEditor/test/browser/codeEditorPane.test.js',
		'src/ash/workbench/contrib/codeEditor/test/common/editorInput.test.js',
		'src/ash/workbench/contrib/preferences/test/browser/settings.test.js',
		'src/ash/workbench/contrib/debug/test/browser/debugService.test.js',
		'src/ash/workbench/contrib/debug/test/browser/debugAdapterManager.test.js',
		'src/ash/workbench/contrib/debug/test/browser/debugConfigurationManager.test.js',
		'src/ash/workbench/services/extensionHost/test/**/*.test.js',
		'src/ash/workbench/services/language/test/common/languageFeaturesService.test.js',
		'src/ash/workbench/contrib/tasks/test/browser/taskService.test.js',
		'src/ash/workbench/services/testing/test/browser/testingService.test.js',
		'src/ash/workbench/services/untitled/test/common/untitledTextEditorService.test.js',
		'src/ash/workbench/test/browser/workbench-theme.test.js',
		'src/ash/workbench/test/common/theme.test.js',
	],
	false,
);
