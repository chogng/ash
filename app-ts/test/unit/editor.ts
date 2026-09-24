import { runUnitTests } from './mocha.ts';

runUnitTests([
	'src/ash/editor/**/test/**/*.test.js',
	'src/ash/workbench/contrib/academic/**/test/**/*.test.js',
	'src/ash/workbench/contrib/codeEditor/**/test/**/*.test.js',
	'src/ash/workbench/contrib/multiDiffEditor/**/test/**/*.test.js',
	'src/ash/workbench/contrib/bulkEdit/**/test/**/*.test.js',
	'src/ash/workbench/contrib/documentEditor/**/test/**/*.test.js',
	'src/ash/workbench/services/documentCollaboration/**/test/**/*.test.js',
	'src/ash/workbench/services/language/**/test/**/*.test.js',
	'src/ash/workbench/services/textMate/**/test/**/*.test.js',
	'src/ash/workbench/services/textmodelResolver/**/test/**/*.test.js',
	'src/ash/workbench/services/textfile/**/test/**/*.test.js',
	'src/ash/workbench/services/workingCopy/**/test/**/*.test.js',
], true);
