import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Icon } from '../../../../base/common/icon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getIconRegistry, registerIcon, resolveIconDefinition } from '../../common/iconRegistry.js';

let testIconId = 0;
function nextIconId(suffix: string): string {
	testIconId += 1;
	return `test-icon-${testIconId}-${suffix}`;
}

test('the icon registry exposes built-in Lxicons and semantic registrations', () => {
	assert.equal(getIconRegistry().getIcon(Lxicon.add.id)?.defaults, resolveIconDefinition(Lxicon.add));
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
