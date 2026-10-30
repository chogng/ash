import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { AgentsWindowGraphicVariant, agentsWindowGraphicConfiguration } from '../../../common/constants.js';
import { renderAgentsWindowGraphic, resolveAgentsWindowGraphicDesign } from '../../../browser/agentSessions/agentsWindowGraphic.js';

suite('Agents window graphic', () => {
	test('selects both designs and preserves the explicit no-graphic choice', () => {
		const variant = AgentsWindowGraphicVariant;
		assert.deepEqual([undefined, false, true].map(multiple => resolveAgentsWindowGraphicDesign(variant.Auto, multiple)), [undefined, variant.WindowComparison, variant.ManyWindowsToOne]);
		assert.equal(resolveAgentsWindowGraphicDesign(variant.None, true), undefined);
		assert.equal(resolveAgentsWindowGraphicDesign(variant.WindowComparison, true), variant.WindowComparison);
		assert.equal(resolveAgentsWindowGraphicDesign(variant.ManyWindowsToOne, false), variant.ManyWindowsToOne);
		for (const value of Object.values(variant)) assert.equal(agentsWindowGraphicConfiguration.parse(value), value);
		assert.throws(() => agentsWindowGraphicConfiguration.parse('unknown'), /supported Agents window illustration/);
	});

	test('the consolidated scene is decorative and explains its meaning in a caption', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			const graphic = renderAgentsWindowGraphic(dom.window.document, AgentsWindowGraphicVariant.ManyWindowsToOne);
			assert.equal(graphic.querySelectorAll('figure').length, 1);
			assert.equal(graphic.querySelector('figcaption')?.textContent, 'All your projects and agents, in one window.');
			assert.equal(graphic.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
			assert.equal(graphic.querySelectorAll('svg > svg').length, 4);
			assert.equal(graphic.querySelectorAll('[tabindex]').length, 0);
		} finally {
			dom.window.close();
		}
	});
});
