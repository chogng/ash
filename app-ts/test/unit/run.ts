import { runUnitTests } from './mocha.ts';

runUnitTests([
	'src/ash/**/test/**/*.test.js',
	'test/architecture/*.test.js',
], true);
