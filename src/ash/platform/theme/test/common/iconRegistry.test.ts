import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Icon } from '../../../../base/common/icon.js';
import { Lxicon, getAllLxicons } from '../../../../base/common/lxicons.js';
import { getIconRegistry, registerIcon, resolveIconDefinition } from '../../common/iconRegistry.js';

let testIconId = 0;
function nextIconId(suffix: string): string {
	testIconId += 1;
	return `test-icon-${testIconId}-${suffix}`;
}

test('derived Lxicon defaults resolve through the product registry and preserve independent theme overrides', () => {
	for (const icon of getAllLxicons()) {
		assert.equal(getIconRegistry().getIcon(icon.id)?.defaults, resolveIconDefinition(icon));
	}
	const artwork = resolveIconDefinition(Lxicon.error);
	assert.equal(resolveIconDefinition(Lxicon.dialogError), artwork);
	const themed = () => '<svg viewBox="0 0 24 24"/>';
	const theme = new Map([[Lxicon.dialogError.id, themed]]);
	assert.equal(resolveIconDefinition(Lxicon.dialogError, theme), themed);
	assert.equal(resolveIconDefinition(Lxicon.error, theme), artwork);
});

test('the icon registry exposes built-in Lxicons and semantic registrations', () => {
	assert.equal(getIconRegistry().getIcon(Lxicon.add.id)?.defaults, resolveIconDefinition(Lxicon.add));
	assert.equal(getIconRegistry().getIcon(Lxicon.debugAlt.id)?.defaults, resolveIconDefinition(Lxicon.debugAlt));
	assert.equal(getIconRegistry().getIcon(Lxicon.splitHorizontal.id)?.defaults, resolveIconDefinition(Lxicon.splitHorizontal));
	assert.equal(getIconRegistry().getIcon(Lxicon.splitVertical.id)?.defaults, resolveIconDefinition(Lxicon.splitVertical));
	const definition = () => '<svg></svg>';
	const icon = registerIcon(nextIconId('definition'), definition, 'A test icon');
	assert.equal(resolveIconDefinition(icon), definition);
	assert.equal(getIconRegistry().getIcon(icon.id)?.description, 'A test icon');
});

test('semantic icons resolve through aliases and theme overrides', () => {
	const definition = () => '<svg></svg>';
	const defaultIcon = registerIcon(nextIconId('default'), definition, 'Default test icon');
	const semanticIcon = registerIcon(nextIconId('semantic'), defaultIcon, 'Semantic test icon');
	assert.equal(resolveIconDefinition(semanticIcon), definition);
	const themed = () => '<svg viewBox="0 0 16 16"/>';
	assert.equal(resolveIconDefinition(semanticIcon, new Map([[defaultIcon.id, themed]])), themed);
	const directTheme = () => '<svg viewBox="0 0 24 24"/>';
	assert.equal(resolveIconDefinition(semanticIcon, new Map([[semanticIcon.id, directTheme]])), directTheme);
});

test('unknown icon IDs fail at the renderer boundary', () => {
	const id = nextIconId('unknown');
	assert.throws(() => resolveIconDefinition(Icon.fromId(id)), new ReferenceError(`Unknown icon '${id}'`));
});

test('circular icon defaults report the complete alias chain', () => {
	const firstId = nextIconId('cycle-first');
	const secondId = nextIconId('cycle-second');
	const first = registerIcon(firstId, Icon.fromId(secondId), 'First test icon');
	registerIcon(secondId, first, 'Second test icon');
	assert.throws(() => resolveIconDefinition(first), new Error(`Circular icon defaults: ${firstId} -> ${secondId} -> ${firstId}`));
});

test('duplicate and malformed icon IDs are rejected', () => {
	const id = nextIconId('duplicate');
	const definition = () => '<svg></svg>';
	registerIcon(id, definition, 'Test icon');
	assert.throws(() => registerIcon(id, definition, 'Duplicate'), TypeError);
	assert.throws(() => registerIcon('Not Valid', definition, 'Invalid'), TypeError);
});
