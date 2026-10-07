import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { ContextKeyService } from '../../browser/contextKeyService.js';
import { ContextKeyExpr, Parser, type ContextKeyValue } from '../../common/contextkey.js';
import { isWindows } from '../../../../base/common/platform.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';

const values: Record<string, ContextKeyValue> = {
	focused: true, locked: false, language: 'typescript', count: '12', enabled: 'yes',
	path: 'src/docs/readme.md', languages: ['typescript', 'rust'], supported: { typescript: false },
	'extension:feature<C-r>': true, empty: '', nil: 'null', file: 'file:///c%3A/Users/Test.ts',
	files: ['file:///c%3A/users/test.ts'],
};

const cases: readonly [string, boolean][] = [
	['true', true], ['false', false], ['!false', true], ['!(focused && locked)', true],
	['focused || locked && false', true], ['(focused || locked) && false', false],
	['language == typescript', true], ["language === 'typescript'", true],
	['count == 12', true], ['count != 12', false], ['count !== 13', true],
	['enabled == true', true], ['enabled != false', true], ['missing == false', true],
	["enabled == 'true'", false], ["nil == null", true], ['empty == ', true],
	['count > 10', true], ['count >= 12', true], ['count < 12', false], ['count <= 12', true],
	['count > invalid', false], ['missing < 1', false], ['locked >= 0', false],
	['language in languages', true], ['language not in languages', false],
	['language in supported', true], ['language in missing', false],
	['language in language', false], ['missing not in languages', true],
	['extension:feature<C-r>', true],
	[String.raw`path =~ /^(src|lib)\/.*[.]md$/i`, true], ['path =~ /[a-z/]+[.]md$/', true],
	[String.raw`path =~ /src\/docs\/readme\.md/`, true],
	[String.raw`path =~ '/readme\.md$/'`, true],
	['path =~ /readme/gimy', true], ['path =~ /[.]rs$/', false],
	['file in files', isWindows],
];

for (const [source, expected] of cases) {
	test(`when clause evaluates ${source}`, () => {
		using context = new ContextKeyService();
		for (const [key, value] of Object.entries(values)) {
			context.setContext(key, value);
		}
		const expression = ContextKeyExpr.deserialize(source);
		assert.ok(expression, source);
		assert.deepEqual([expression.evaluate(context), expression.evaluate(context)], [expected, expected]);
	});
}

test('membership observes changes to both the selected value and its collection', () => {
	using context = new ContextKeyService();
	const expression = ContextKeyExpr.deserialize('language in supported')!;
	const results: boolean[] = [];
	using listener = context.onDidChangeContext(event => {
		if (event.affectsSome(expression.keys())) {
			results.push(expression.evaluate(context));
		}
	});
	context.setContext('language', 'rust');
	context.setContext('supported', { rust: false });
	context.setContext('supported', ['typescript']);
	context.setContext('language', 'typescript');
	assert.deepEqual({ keys: [...expression.keys()].sort(), results }, {
		keys: ['language', 'supported'], results: [false, true, false, true],
	});
});

test('membership excludes inherited object properties and keeps non-file strings case sensitive', () => {
	using context = new ContextKeyService();
	context.setContext('name', 'toString');
	context.setContext('collection', {});
	const expression = ContextKeyExpr.deserialize('name in collection')!;
	assert.equal(expression.evaluate(context), false);
	context.setContext('name', 'git:/Test.ts');
	context.setContext('collection', ['git:/test.ts']);
	assert.equal(expression.evaluate(context), false);
});

test('parser resets diagnostics after invalid and empty resources', () => {
	const parser = new Parser();
	for (const source of ['focused &&', '(focused', 'language not supported', 'path =~ /[/', 'path =~ /x/ii', 'x = y', "language == 'unfinished", '!focused == true', '!!focused', '']) {
		assert.equal(parser.parse(source), undefined, source);
		assert.ok(parser.lexingErrors.length + parser.parsingErrors.length > 0, source);
		assert.ok(parser.parse('true'));
		assert.deepEqual([parser.lexingErrors, parser.parsingErrors], [[], []]);
	}
	assert.equal(parser.parse('focused &&'), undefined);
	assert.deepEqual(parser.parsingErrors.map(({ offset, lexeme }) => ({ offset, lexeme })), [{ offset: 10, lexeme: 'EOF' }]);
});

test('deserialization distinguishes absent, malformed and false conditions', () => {
	assert.deepEqual([ContextKeyExpr.deserialize(null), ContextKeyExpr.deserialize(undefined), ContextKeyExpr.deserialize(''), ContextKeyExpr.deserialize('true false')],
		[undefined, undefined, undefined, undefined]);
	using context = new ContextKeyService();
	assert.equal(ContextKeyExpr.deserialize('false')!.evaluate(context), false);
});

test('parser and scanner report translated diagnostics with token locations', () => {
	const catalog = JSON.parse(readFileSync('localization/zh-CN/workbench.json', 'utf8'));
	setNlsMessages('zh-CN', catalog);
	try {
		const parser = new Parser();
		assert.equal(parser.parse('focused &&'), undefined);
		assert.equal(parser.parsingErrors[0].message, '预期为上下文键，收到“EOF”。');
		assert.equal(parser.parse("name == 'unfinished"), undefined);
		assert.equal(parser.lexingErrors[0].additionalInfo, '字符串未结束。');
		assert.equal(parser.lexingErrors[0].offset, 8);
	} finally {
		resetNlsResolver();
	}
});
