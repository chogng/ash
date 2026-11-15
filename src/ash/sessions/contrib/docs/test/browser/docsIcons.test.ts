import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { appendIcon, setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { getIconDefinition, getIconRegistry, resolveIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';
import { checklistIcon, tableIcon } from '../../browser/docsIcons.js';

for (const [semantic, source] of [[checklistIcon, Lxicon.plan], [tableIcon, Lxicon.sheets]] as const) {
	test(`${semantic.id} retains its default reference and honors theme precedence`, () => {
		assert.equal(getIconRegistry().getIcon(semantic.id)?.defaults, source);
		assert.equal(resolveIconDefinition(semantic), resolveIconDefinition(source));
		const sourceTheme = { fontCharacter: 'P' };
		const semanticTheme = { fontCharacter: 'C' };
		assert.equal(resolveIconDefinition(semantic, new Map([[source.id, sourceTheme]])), sourceTheme);
		const theme = new Map([[source.id, sourceTheme], [semantic.id, semanticTheme]]);
		assert.equal(resolveIconDefinition(semantic, theme), semanticTheme);
		assert.equal(resolveIconDefinition(source, theme), sourceTheme);
	});
}

test('mounted checklist follows the default chain and keeps its identity across theme changes', () => {
	const document = new JSDOM('<!doctype html><body></body>').window.document;
	try {
		setIconResolver(document, icon => getIconDefinition(icon));
		const checklist = appendIcon(checklistIcon, document.body);
		const plan = appendIcon(Lxicon.plan, document.body);
		assert.equal(checklist.dataset.ashIconCharacter, plan.dataset.ashIconCharacter);
		assert.equal(checklist.dataset.ashIconId, 'checklist');
		assert.equal(checklist.getAttribute('aria-hidden'), 'true');
		const theme = new Map([[Lxicon.plan.id, { fontCharacter: 'P' }]]);
		setIconResolver(document, icon => getIconDefinition(icon, theme));
		assert.equal(checklist.dataset.ashIconCharacter, 'P');
		theme.set(checklistIcon.id, { fontCharacter: 'C' });
		setIconResolver(document, icon => getIconDefinition(icon, theme));
		assert.equal(checklist.dataset.ashIconCharacter, 'C');
		assert.equal(plan.dataset.ashIconCharacter, 'P');
		setIconResolver(document, icon => getIconDefinition(icon));
		assert.equal(checklist.dataset.ashIconCharacter, resolveIconDefinition(Lxicon.plan).fontCharacter);
	} finally {
		document.defaultView?.close();
	}
});
