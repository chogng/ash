import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { match, parse } from '../../common/glob.js';

suite('Configured path globs', () => {
	test('matches zero or more directories, alternatives and character classes', () => {
		assert.deepEqual([
			match('**/*.ts', 'main.ts'),
			match('**/*.ts', 'src/nested/main.ts'),
			match('src/**/*.{ts,tsx}', 'src/main.tsx'),
			match('src/**/file[0-9]?.ts', 'src/deep/file1a.ts'),
			match('src/[!a]*.ts', 'src/b.ts'),
			match('src/[!a]*.ts', 'src/a.ts'),
			match('*.ts', 'src/main.ts'),
			match('**/*.{ts,{js,jsx}}', 'main.jsx'),
		], [true, true, true, true, true, false, false, true]);
	});

	test('uses relative bases and normalizes Windows separators', () => {
		assert.equal(match({ base: 'C:\\project', pattern: 'src\\**\\*.ts' }, 'C:\\project\\src\\main.ts'), true);
	});

	test('disables false rules and evaluates sibling conditions only when supplied', () => {
		const expression = parse({ '**/*.map': false, '**/*.js': { when: '$(basename).ts' } });
		assert.deepEqual([
			expression('main.map'),
			expression('src/main.js'),
			expression('src/main.js', undefined, name => name === 'main.ts'),
			expression('src/main.js', undefined, name => name === 'other.ts'),
		], [null, null, '**/*.js', null]);
	});
});
