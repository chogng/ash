import { runUnitTests } from './mocha.ts';

await runUnitTests([
	'src/ash/**/test/**/*.test.js',
	'test/architecture/*.test.js',
	'extensions/*/test/**/*.test.js',
], true);
