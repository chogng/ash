import { runUnitTests } from './mocha.ts';

await runUnitTests(
	[
		'src/ash/editor/**/test/**/*.test.js',
		'src/ash/workbench/contrib/codeEditor/**/test/**/*.test.js',
		'src/ash/workbench/contrib/format/**/test/**/*.test.js',
		'src/ash/workbench/contrib/multiDiffEditor/**/test/**/*.test.js',
		'src/ash/workbench/contrib/bulkEdit/**/test/**/*.test.js',
		'src/ash/workbench/services/language/**/test/**/*.test.js',
		'src/ash/workbench/services/extensions/test/browser/builtinCodeContributions.test.js',
		'src/ash/workbench/services/treeSitter/**/test/**/*.test.js',
		'src/ash/workbench/services/themes/**/test/**/*.test.js',
		'src/ash/workbench/services/textmodelResolver/**/test/**/*.test.js',
		'src/ash/workbench/services/textfile/**/test/**/*.test.js',
		'src/ash/workbench/services/workingCopy/**/test/**/*.test.js',
	],
	true,
);
