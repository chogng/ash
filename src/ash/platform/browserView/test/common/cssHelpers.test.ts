import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { collapseToShorthands, filterInheritableDeclarations, formatMatchedStyles } from '../../common/cssHelpers.js';

suite('Browser style observations', () => {
	test('author, inherited and pseudo rules preserve variables while browser defaults remain metadata', () => {
		const style = (name: string, value: string) => ({ cssProperties: [{ name, value }] });
		const rule = (selector: string, name: string, value: string, origin = 'regular') => ({
			rule: { selectorList: { selectors: [{ text: selector }] }, origin, style: style(name, value) },
		});
		const result = formatMatchedStyles({
			inlineStyle: style('color', 'var(--accent)'),
			matchedCSSRules: [rule('input', 'display', 'inline-block', 'user-agent')],
			inherited: [{ matchedCSSRules: [rule('body', 'font-family', 'system-ui'), rule('body', 'margin', '0')] }],
			pseudoElements: [{ pseudoType: 'before', matches: [rule('input::before', 'content', '";:"')] }],
		});
		assert.deepEqual([...result.referencedVars], ['--accent']);
		assert.deepEqual([...result.userAgentPropertyNames], ['display']);
		assert.ok(result.rulesText.includes('font-family: system-ui'));
		assert.ok(result.rulesText.includes('content: ";:"'));
		assert.ok(!result.rulesText.includes('margin') && !result.rulesText.includes('display'));
		assert.equal(filterInheritableDeclarations('margin: 1px; font-family: "semi;colon"; --image: url("data:a;b");'), 'font-family: "semi;colon"; --image: url("data:a;b");');
	});

	test('box compaction leaves incomplete and variable-dependent declarations intact', () => {
		assert.deepEqual(
			collapseToShorthands(
				new Map([
					['margin-top', '1px'],
					['margin-right', '2px'],
					['margin-bottom', '1px'],
					['margin-left', '2px'],
				]),
			),
			['margin: 1px 2px;'],
		);
		const values = new Map([
			['padding-top', 'var(--space)'],
			['padding-right', '2px'],
			['padding-bottom', '1px'],
			['padding-left', '2px'],
		]);
		assert.ok(collapseToShorthands(values).some(line => line === 'padding-top: var(--space);'));
		assert.equal(values.size, 4);
	});
});
