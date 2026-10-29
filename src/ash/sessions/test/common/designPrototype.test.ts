import assert from 'node:assert/strict';
import { test } from 'mocha';
import { generateUuid } from '../../../base/common/uuid.js';
import { DesignModel } from '../../contrib/creator/common/model/designModel.js';
import { DocumentCommands } from '../../contrib/creator/common/commands/documentCommands.js';
import { documentFromShapes, flattenDesignShapes, parseDesignDocument, serializeDesignDocument, type DesignShape } from '../../contrib/creator/common/model/document.js';
import { defaultPrototypeTransition, type PrototypeFrame, type PrototypeInteraction, type PrototypeStep } from '../../contrib/creator/common/model/prototype.js';
import { PrototypePlayback, prototypeProgress, samplePrototypeTransition, smartAnimate } from '../../contrib/creator/common/model/prototypePlayback.js';

function screen(name: string, children: readonly DesignShape[] = []): PrototypeFrame {
	return {
		id: generateUuid(),
		kind: 'frame',
		name,
		x: 0,
		y: 0,
		width: 390,
		height: 844,
		rotation: 0,
		fill: '#ffffff',
		clip: true,
		children,
	};
}
function box(name: string, x = 0): DesignShape {
	return {
		id: generateUuid(),
		kind: 'rectangle',
		name,
		x,
		y: 20,
		width: 80,
		height: 40,
		rotation: 0,
		fill: '#000000',
	};
}
function interaction(action: PrototypeStep['action'], destination?: string, changes: Partial<PrototypeStep> = {}): PrototypeInteraction {
	return {
		id: generateUuid(),
		trigger: 'click',
		actions: [{ action, ...(destination ? { destination } : {}), transition: defaultPrototypeTransition, ...changes }],
	};
}
function execute(player: PrototypePlayback, interaction: PrototypeInteraction, sourceId?: string): boolean {
	return [...player.run(interaction, sourceId)].length > 0;
}

test('Prototype commands create branched wires and a flow in one edit, save immutable settings and undo target deletion', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const a = screen('Home', [box('Sign in'), box('Sign up')]),
		b = screen('Login'),
		c = screen('Register');
	model.replace(documentFromShapes([a, b, c]));
	commands.prototype.connect(new Set([a.children[0].id]), b.id);
	assert.equal(model.value.shapes[0].flowStart, 'Flow 1');
	assert.equal((model.value.shapes[0] as PrototypeFrame).children[0].interactions![0].actions[0].destination, b.id);
	model.undo();
	assert.equal(model.value.shapes[0].flowStart, undefined);
	model.redo();
	commands.prototype.connect(new Set([a.children[1].id]), c.id);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.ok(Object.isFrozen((model.value.shapes[0] as PrototypeFrame).children[0].interactions![0].actions[0].transition));
	commands.removeShapes(new Set([b.id]));
	assert.equal((model.value.shapes[0] as PrototypeFrame).children[0].interactions?.length, 0);
	model.undo();
	assert.equal((model.value.shapes[0] as PrototypeFrame).children[0].interactions![0].actions[0].destination, b.id);
});

test('Prototype duplicate remaps connections inside duplicated screens and keeps external destinations', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const b = screen('Detail'),
		c = screen('External');
	const a = {
		...screen('Home'),
		flowStart: 'Checkout',
		interactions: [interaction('navigate', b.id), interaction('overlay', c.id)],
	};
	model.replace(documentFromShapes([a, b, c]));
	const copies = commands.duplicate(new Set([a.id, b.id]));
	const copy = model.value.shapes.find(shape => shape.id === copies[0])!;
	assert.equal(copy.flowStart, 'Checkout');
	assert.deepEqual(
		copy.interactions!.map(item => item.actions[0].destination),
		[copies[1], c.id],
	);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Prototype file boundary rejects invalid actions, durations, triggers, URLs, duplicate IDs and nested starting points', () => {
	const target = screen('Target');
	const source = { ...screen('Home'), interactions: [interaction('navigate', target.id)] };
	const document = documentFromShapes([source, target]);
	for (const change of [
		(item: any) => {
			item.actions[0].transition.duration = -1;
		},
		(item: any) => {
			item.actions[0].transition.duration = 10001;
		},
		(item: any) => {
			item.trigger = 'unknown';
		},
		(item: any) => {
			item.actions[0].action = 'script';
		},
		(item: any) => {
			item.actions[0].action = 'url';
			item.actions[0].url = 'javascript:alert(1)';
		},
		(item: any) => {
			item.actions[0].action = 'url';
			item.actions[0].url = 'command:workbench.action.closeWindow';
		},
		(item: any) => {
			item.trigger = 'delay';
		},
		(item: any) => {
			item.trigger = 'key';
		},
		(item: any) => {
			item.actions[0].destination = 'not-an-id';
		},
		(item: any) => {
			item.actions[0].transition.extra = true;
		},
	]) {
		const wire = JSON.parse(serializeDesignDocument(document));
		change(wire.artifacts[document.artifactId].objects[source.id].interactions[0]);
		assert.throws(() => parseDesignDocument(JSON.stringify(wire)), /prototype/iu);
	}
	const wire = JSON.parse(serializeDesignDocument(document));
	const items = wire.artifacts[document.artifactId].objects[source.id].interactions;
	items.push(items[0]);
	assert.throws(() => parseDesignDocument(JSON.stringify(wire)), /prototype/iu);
	assert.throws(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([screen('Root', [{ ...screen('Nested'), flowStart: 'Invalid' }])]))), /prototype/iu);
});

test('Prototype instances inherit interactions and retain explicit overrides across main changes', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const target = screen('Target');
	const main: PrototypeFrame = {
		...screen('Button', [box('Label')]),
		component: { kind: 'main' },
		interactions: [interaction('navigate', target.id)],
	};
	model.replace(documentFromShapes([main, target]));
	const id = commands.components.createInstance(main.id)!;
	assert.equal(model.value.shapes.find(shape => shape.id === id)!.interactions![0].actions[0].destination, target.id);
	commands.prototype.setInteractions(id, [interaction('back')]);
	commands.prototype.setInteractions(main.id, [interaction('close')]);
	assert.equal(model.value.shapes.find(shape => shape.id === id)!.interactions![0].actions[0].action, 'back');
	commands.components.reset(id);
	assert.equal(model.value.shapes.find(shape => shape.id === id)!.interactions![0].actions[0].action, 'close');
});

test('Prototype playback follows navigation history, stacks and swaps overlays without changing the document', () => {
	const a = screen('Home'),
		b = screen('Detail'),
		c = screen('Dialog'),
		d = screen('Menu');
	const document = documentFromShapes([a, b, c, d]);
	const saved = serializeDesignDocument(document);
	const player = new PrototypePlayback(document.shapes, a.id);
	assert.equal(execute(player, interaction('back')), false);
	execute(player, interaction('navigate', b.id));
	assert.equal(player.canBack, true);
	execute(player, interaction('overlay', c.id));
	execute(player, interaction('overlay', d.id));
	assert.equal(player.state.overlays.length, 2);
	execute(player, interaction('close'));
	assert.equal(player.activeFrame.id, c.id);
	execute(player, interaction('swap', d.id));
	assert.equal(player.activeFrame.id, d.id);
	assert.equal(player.state.overlays.length, 1);
	execute(player, interaction('navigate', a.id));
	execute(player, interaction('back'));
	assert.equal(player.activeFrame.id, d.id);
	execute(player, interaction('close'));
	execute(player, interaction('back'));
	assert.equal(player.activeFrame.id, a.id);
	assert.equal(serializeDesignDocument(document), saved);
});

test('Prototype temporary interactions restore both page and history and invalid destinations are inert', () => {
	const a = screen('Home'),
		b = screen('Detail');
	const player = new PrototypePlayback([a, b], a.id);
	const snapshot = player.snapshot();
	execute(player, interaction('navigate', b.id));
	player.restore(snapshot);
	assert.equal(player.activeFrame.id, a.id);
	assert.equal(player.canBack, false);
	assert.equal(execute(player, interaction('navigate', generateUuid())), false);
	assert.equal(execute(player, interaction('navigate', a.id)), false);
});

test('Prototype overlay placement and input exclude hidden subtrees and covered screens', () => {
	const click = interaction('back');
	const a = screen('Home', [{ ...box('Background'), interactions: [click] }]);
	const dialog = {
		...screen('Dialog', [
			{ ...box('Close'), interactions: [click] },
			{ ...screen('Hidden', [{ ...box('Invisible'), interactions: [click] }]), visible: false },
		]),
		width: 100,
		height: 200,
	};
	const player = new PrototypePlayback([a, dialog], a.id);
	execute(
		player,
		interaction('overlay', dialog.id, {
			overlay: { position: 'bottomRight', closeOutside: false, background: true },
		}),
	);
	assert.deepEqual(
		player.hotspots.map(shape => shape.name),
		['Close'],
	);
	const placed = player.scene.children.at(-1)!;
	assert.deepEqual([placed.x, placed.y], [290, 644]);
});

test('Smart Animate matches hierarchy and names, interpolates geometry and color, and dissolves unmatched layers', () => {
	const from = screen('A', [box('Button', 0), box('Removed')]);
	const to = screen('B', [{ ...box('Button', 100), width: 160, rotation: 90, fill: '#ffffff', opacity: 0.5 }, box('Added')]);
	const sampled = smartAnimate(from, to, 0.5) as PrototypeFrame;
	assert.deepEqual([sampled.children[0].x, sampled.children[0].width, sampled.children[0].rotation, sampled.children[0].fill, sampled.children[0].opacity], [50, 120, 45, '#808080ff', 0.75]);
	assert.deepEqual(
		sampled.children.slice(1).map(shape => [shape.name, shape.opacity]),
		[
			['Added', 0.5],
			['Removed', 0.5],
		],
	);
	const nested = smartAnimate(screen('A', [screen('Old parent', [box('Same')])]), screen('B', [screen('New parent', [box('Same', 100)])]), 0.5) as PrototypeFrame;
	assert.equal(nested.children.length, 2);
	assert.equal((nested.children[0] as PrototypeFrame).children[0].x, 100);
});

test('Prototype transitions have stable endpoints, directional displacement and CSS easing curves', () => {
	const a = { ...screen('A'), x: 0, y: 0 },
		b = { ...screen('B'), x: 0, y: 0 };
	for (const type of ['instant', 'dissolve', 'smart', 'moveIn', 'moveOut', 'push', 'slideIn', 'slideOut'] as const) {
		assert.deepEqual(samplePrototypeTransition(a, b, { ...defaultPrototypeTransition, type }, 1), [{ shape: b, x: 0, y: 0, opacity: 1 }]);
	}
	const push = samplePrototypeTransition(a, b, { ...defaultPrototypeTransition, type: 'push', easing: 'linear' }, 0.5);
	assert.deepEqual(
		push.map(layer => [layer.x, layer.y]),
		[
			[195, 0],
			[-195, 0],
		],
	);
	assert.ok(prototypeProgress(0.5, 'easeIn') < 0.5);
	assert.ok(prototypeProgress(0.5, 'easeOut') > 0.5);
	assert.ok(Math.abs(prototypeProgress(0.5, 'easeInOut') - 0.5) < 0.00001);
	assert.equal(flattenDesignShapes([a, b]).length, 2);
});

test('Prototype flow removal survives saving and overlays cannot duplicate the active page identity', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const frame = screen('Home');
	model.replace(documentFromShapes([frame]));
	commands.prototype.setFlow(frame.id, 'Checkout');
	commands.prototype.setFlow(frame.id, undefined);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	const player = new PrototypePlayback([frame], frame.id);
	assert.equal(execute(player, interaction('overlay', frame.id)), false);
	assert.equal(execute(player, interaction('swap', frame.id)), false);
	assert.equal(player.state.overlays.length, 0);
});

test('Prototype draft links remain inert until a URL is entered and nested destinations are rejected', () => {
	const nested = screen('Nested');
	const home = { ...screen('Home', [nested]), interactions: [interaction('url', undefined, { url: '' })] };
	const document = documentFromShapes([home]);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(document)), document);
	assert.equal(execute(new PrototypePlayback(document.shapes, home.id), home.interactions[0]), false);
	assert.throws(() => parseDesignDocument(serializeDesignDocument(documentFromShapes([{ ...home, interactions: [interaction('navigate', nested.id)] }]))), /prototype/iu);
});

test('Interactive components change only the triggered instance, retain text overrides and restore temporary variants', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const label = { ...box('Label'), kind: 'text' as const, text: 'Default', fontSize: 16 };
	const first: PrototypeFrame = { ...screen('Button', [label]), component: { kind: 'main' }, width: 120, height: 40 };
	model.replace(documentFromShapes([first]));
	const secondId = commands.components.addVariant(first.id)!;
	commands.prototype.connect(new Set([first.id]), secondId);
	const second = flattenDesignShapes(model.value.shapes).find(shape => shape.id === secondId)!;
	commands.updateShape({ ...second, fill: '#ff0000' });
	const instanceId = commands.components.createInstance(first.id)!;
	const anotherId = commands.components.createInstance(first.id)!;
	const instance = flattenDesignShapes(model.value.shapes).find(shape => shape.id === instanceId) as PrototypeFrame;
	commands.updateShape({ ...instance.children[0], text: 'Custom' } as DesignShape);
	commands.prototype.setInteractions(instanceId, [...instance.interactions!, interaction('back')]);
	const roots = model.value.shapes;
	const home = screen(
		'Home',
		roots.filter(shape => [instanceId, anotherId].includes(shape.id)),
	);
	model.applyEdit([...roots.filter(shape => ![instanceId, anotherId].includes(shape.id)), home]);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	const saved = serializeDesignDocument(model.value);
	const player = new PrototypePlayback(model.value.shapes, home.id);
	const snapshot = player.snapshot();
	const trigger = player.hotspots.find(shape => shape.id === instanceId)!.interactions![0];
	assert.equal(trigger.actions[0].action, 'changeTo');
	assert.equal(execute(player, trigger, instanceId), true);
	const changed = flattenDesignShapes([player.activeFrame]).find(shape => shape.id === instanceId) as PrototypeFrame;
	assert.equal(changed.interactions?.at(-1)?.actions[0].action, 'back');
	assert.equal(changed.instance?.componentId, secondId);
	assert.equal(changed.fill, '#ff0000');
	assert.equal((changed.children[0] as typeof label).text, 'Custom');
	assert.equal((flattenDesignShapes([player.activeFrame]).find(shape => shape.id === anotherId) as PrototypeFrame).instance?.componentId, first.id);
	assert.equal(player.canBack, false);
	player.restore(snapshot);
	assert.equal((flattenDesignShapes([player.activeFrame]).find(shape => shape.id === instanceId) as PrototypeFrame).instance?.componentId, first.id);
	assert.equal(serializeDesignDocument(model.value), saved);
});

test('Deleting a prototype destination does not turn inherited interactions into instance overrides', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const target = screen('Target');
	const main: PrototypeFrame = {
		...screen('Button'),
		component: { kind: 'main' },
		interactions: [interaction('navigate', target.id)],
	};
	model.replace(documentFromShapes([main, target]));
	const id = commands.components.createInstance(main.id)!;
	commands.removeShapes(new Set([target.id]));
	assert.equal(model.value.shapes.find(shape => shape.id === id)?.overrides?.includes('interactions') ?? false, false);
	commands.prototype.setInteractions(main.id, [interaction('back')]);
	assert.equal(model.value.shapes.find(shape => shape.id === id)!.interactions![0].actions[0].action, 'back');
});

test('Prototype flow starting points belong to placed instances and survive main edits and reset', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const main: PrototypeFrame = { ...screen('Button'), component: { kind: 'main' } };
	model.replace(documentFromShapes([main]));
	const id = commands.components.createInstance(main.id)!;
	commands.prototype.setFlow(id, 'Button flow');
	commands.updateShape({ ...main, fill: '#ff0000' });
	commands.components.reset(id);
	assert.equal(model.value.shapes.find(shape => shape.id === id)!.flowStart, 'Button flow');
	assert.equal(model.value.shapes.find(shape => shape.id === main.id)!.flowStart, undefined);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
});

test('Prototype expressions follow precedence, preserve variable identities and reject coercion or executable syntax', async () => {
	const { parsePrototypeExpression: parse, evaluatePrototypeExpression: evaluate, formatPrototypeExpression: format } = await import('../../contrib/creator/common/model/prototypeExpression.js');
	const { variables } = prototypeResources();
	const calc = (text: string) => evaluate(parse(text, variables), id => (id === variables[0].id ? 3 : undefined));
	assert.equal(calc('count + 2 * 4'), 11);
	assert.equal(calc('(count + 2) * 4'), 20);
	assert.equal(calc('count >= 3 and not (count == 4) or false'), true);
	assert.equal(calc('"Items: " + count + "!"'), 'Items: 3!');
	assert.equal(calc('-count / 2'), -1.5);
	assert.equal(calc('1 / 0'), undefined);
	assert.equal(calc('1e308 * 1e308'), undefined);
	const expression = parse('count + 1', variables);
	const renamed = variables.map((variable, index) => (index === 0 ? { ...variable, name: 'cart count' } : variable));
	assert.equal(format(expression, renamed), '(`cart count` + 1)');
	assert.deepEqual(parse(format(expression, renamed), renamed), expression);
	for (const text of [
		'count = 5',
		'count.toString()',
		'true + 1',
		'3 and true',
		'"4" == 4',
		'"x" > "a"',
		'constructor()',
		'1e999',
		'unknown + 1',
		'count +',
		'('.repeat(40) + '1' + ')'.repeat(40),
	]) {
		assert.throws(() => parse(text, variables), /expression/iu, text);
	}
	assert.equal(
		evaluate(parse('false and count > 2', variables), () => undefined),
		false,
	);
	assert.equal(
		evaluate(parse('count > 2', variables), () => undefined),
		undefined,
	);
});

function prototypeResources() {
	const collectionId = generateUuid(),
		first = generateUuid(),
		second = generateUuid(),
		count = generateUuid(),
		alias = generateUuid();
	return {
		collections: [
			{
				id: collectionId,
				name: 'State',
				modes: [
					{ id: first, name: 'One' },
					{ id: second, name: 'Two' },
				],
				defaultMode: first,
			},
		],
		variables: [
			{ id: count, name: 'count', type: 'number' as const, collectionId, values: { [first]: 1, [second]: 20 } },
			{
				id: alias,
				name: 'width',
				type: 'number' as const,
				collectionId,
				values: { [first]: { alias: count }, [second]: { alias: count } },
			},
		],
		styles: [],
		libraries: [],
	};
}

test('Prototype chains evaluate conditions after prior writes and yield animations in order', async () => {
	const { parsePrototypeExpression: parse } = await import('../../contrib/creator/common/model/prototypeExpression.js');
	const resources = prototypeResources(),
		a = screen('Home'),
		b = screen('Cart'),
		c = screen('Confirmation');
	const write: PrototypeStep = {
		action: 'setVariable',
		variableId: resources.variables[0].id,
		value: parse('count + 1', resources.variables),
		transition: defaultPrototypeTransition,
	};
	const conditional: PrototypeStep = {
		action: 'conditional',
		transition: defaultPrototypeTransition,
		branches: [
			{
				condition: parse('count == 2', resources.variables),
				actions: [
					{
						...interaction('navigate', b.id).actions[0],
						transition: { ...defaultPrototypeTransition, type: 'smart' },
					},
					interaction('overlay', c.id).actions[0],
				],
			},
			{ actions: [interaction('navigate', c.id).actions[0]] },
		],
	};
	const player = new PrototypePlayback([a, b, c], a.id, resources),
		chain = player.run({ ...interaction('back'), actions: [write, conditional] });
	assert.equal(chain.next().value?.from.id, a.id);
	assert.equal(player.activeFrame.id, a.id);
	assert.equal(chain.next().value?.transition.type, 'smart');
	assert.equal(player.activeFrame.id, b.id);
	assert.equal(player.state.overlays.length, 0);
	assert.equal(chain.next().value?.from.id, b.id);
	assert.equal(player.activeFrame.id, c.id);
	assert.equal(chain.next().done, true);
	const reversed = new PrototypePlayback([a, b, c], a.id, resources);
	execute(reversed, { ...interaction('back'), actions: [conditional, write] });
	assert.equal(reversed.activeFrame.id, c.id);
	assert.equal(reversed.state.overlays.length, 0);
});

test('Prototype writes and modes update bindings and aliases across navigation, reset only on restart or snapshot restore', async () => {
	const { parsePrototypeExpression: parse } = await import('../../contrib/creator/common/model/prototypeExpression.js');
	const resources = prototypeResources(),
		collection = resources.collections[0],
		variable = resources.variables[0];
	const a = screen('Home', [{ ...box('Size'), bindings: { width: resources.variables[1].id } }]),
		b = screen(
			'Other',
			a.children.map(child => ({ ...child, id: generateUuid() })),
		);
	const doc = documentFromShapes([a, b], { documentId: generateUuid(), artifactId: generateUuid(), resources }),
		saved = serializeDesignDocument(doc),
		player = new PrototypePlayback(doc.shapes, a.id, resources),
		snapshot = player.snapshot();
	const change = (action: PrototypeStep): void => {
		execute(player, { ...interaction('back'), actions: [action] });
	};
	assert.equal(player.activeFrame.children[0].width, 1);
	change({
		action: 'setMode',
		collectionId: collection.id,
		modeId: collection.modes[1].id,
		transition: defaultPrototypeTransition,
	});
	assert.equal(player.activeFrame.children[0].width, 20);
	change({
		action: 'setVariable',
		variableId: variable.id,
		value: parse('count + 2', resources.variables),
		transition: defaultPrototypeTransition,
	});
	assert.equal(player.activeFrame.children[0].width, 22);
	change(interaction('navigate', b.id).actions[0]);
	assert.equal(player.activeFrame.children[0].width, 22);
	change(interaction('back').actions[0]);
	assert.equal(player.activeFrame.children[0].width, 22);
	player.restore(snapshot);
	assert.equal(player.activeFrame.children[0].width, 1);
	assert.equal(new PrototypePlayback(doc.shapes, a.id, resources).activeFrame.children[0].width, 1);
	assert.equal(serializeDesignDocument(doc), saved);
});

test('Prototype conditionals use the first matching branch, nest, and keep missing references or invalid results inert', async () => {
	const { parsePrototypeExpression: parse } = await import('../../contrib/creator/common/model/prototypeExpression.js');
	const resources = prototypeResources(),
		a = screen('Home'),
		b = screen('Yes'),
		c = screen('Else');
	const nested: PrototypeStep = {
		action: 'conditional',
		transition: defaultPrototypeTransition,
		branches: [{ condition: parse('count > 0', resources.variables), actions: [interaction('navigate', b.id).actions[0]] }, { actions: [interaction('navigate', c.id).actions[0]] }],
	};
	const player = new PrototypePlayback([a, b, c], a.id, resources);
	const actions: PrototypeStep[] = [
		{
			action: 'setVariable',
			variableId: resources.variables[0].id,
			value: parse('1 / 0', resources.variables),
			transition: defaultPrototypeTransition,
		},
		{
			...nested,
			branches: [
				{ condition: parse('count < 0', resources.variables), actions: [] },
				{ condition: parse('count == 1', resources.variables), actions: [nested] },
				{ actions: [interaction('navigate', c.id).actions[0]] },
			],
		},
	];
	const effects = [...player.run({ ...interaction('back'), actions })];
	assert.equal(effects[0].failed, true);
	assert.equal(player.activeFrame.id, b.id);
	const unresolved = {
		...nested,
		branches: [
			{
				condition: { kind: 'variable' as const, id: generateUuid() },
				actions: [interaction('navigate', c.id).actions[0]],
			},
			{ actions: [interaction('navigate', a.id).actions[0]] },
		],
	};
	assert.equal([...player.run({ ...interaction('back'), actions: [unresolved] })][0].failed, true);
	assert.equal(player.activeFrame.id, b.id);
});

test('Prototype action trees round trip, freeze, remap conditional wires on duplication, and remove only deleted target actions', async () => {
	const { parsePrototypeExpression: parse } = await import('../../contrib/creator/common/model/prototypeExpression.js');
	const resources = prototypeResources(),
		b = screen('Target'),
		c = screen('Other');
	const nested: PrototypeStep = {
		action: 'conditional',
		transition: defaultPrototypeTransition,
		branches: [
			{
				condition: parse('count > 0', resources.variables),
				actions: [interaction('navigate', b.id).actions[0], interaction('overlay', c.id).actions[0]],
			},
			{ actions: [] },
		],
	};
	const a = {
		...screen('Home'),
		interactions: [
			{
				...interaction('back'),
				actions: [nested, interaction('url', undefined, { url: 'https://example.com' }).actions[0]],
			},
		],
	};
	using model = new DesignModel();
	model.replace(documentFromShapes([a, b, c], { documentId: generateUuid(), artifactId: generateUuid(), resources }));
	const commands = new DocumentCommands(model);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	assert.ok(Object.isFrozen(model.value.shapes[0].interactions![0].actions[0].branches![0].condition));
	const copies = commands.duplicate(new Set([a.id, b.id]));
	const copied = model.value.shapes.find(shape => shape.id === copies[0])!;
	assert.deepEqual(
		copied.interactions![0].actions[0].branches![0].actions.map(action => action.destination),
		[copies[1], c.id],
	);
	commands.removeShapes(new Set([b.id]));
	assert.equal(model.value.shapes[0].interactions![0].actions[0].branches![0].actions.length, 1);
	assert.equal(model.value.shapes[0].interactions![0].actions.length, 2);
	model.undo();
	assert.equal(model.value.shapes[0].interactions![0].actions[0].branches![0].actions.length, 2);
});

test('Prototype persistence migrates single actions and rejects malformed action trees, expressions and spring parameters', () => {
	const resources = prototypeResources(),
		b = screen('Target'),
		a = { ...screen('Home'), interactions: [interaction('navigate', b.id)] },
		doc = documentFromShapes([a, b], { documentId: generateUuid(), artifactId: generateUuid(), resources });
	const raw = () => JSON.parse(serializeDesignDocument(doc));
	const legacy = raw(),
		item = legacy.artifacts[doc.artifactId].objects[a.id].interactions[0];
	Object.assign(item, item.actions[0]);
	delete item.actions;
	assert.deepEqual(parseDesignDocument(JSON.stringify(legacy)), doc);
	for (const mutate of [
		(item: any) => {
			item.actions = [];
		},
		(item: any) => {
			item.actions[0].transition.easing = 'spring';
		},
		(item: any) => {
			item.actions[0].transition.spring = { mass: 0, stiffness: 100, damping: 10, initialVelocity: 0 };
		},
		(item: any) => {
			item.actions[0] = {
				action: 'conditional',
				transition: defaultPrototypeTransition,
				branches: [{ actions: [] }],
			};
		},
		(item: any) => {
			item.actions[0] = {
				action: 'conditional',
				transition: defaultPrototypeTransition,
				branches: [{ condition: { kind: 'literal', value: 5 }, actions: [] }],
			};
		},
		(item: any) => {
			item.actions[0] = {
				action: 'setVariable',
				transition: defaultPrototypeTransition,
				variableId: resources.variables[0].id,
				value: { kind: 'literal', value: true },
			};
		},
		(item: any) => {
			item.actions[0] = {
				action: 'setVariable',
				transition: defaultPrototypeTransition,
				variableId: resources.variables[0].id,
				value: { kind: 'call', value: 'alert(1)' },
			};
		},
		(item: any) => {
			const leaf = item.actions[0];
			for (let i = 0; i < 18; i++) {
				item.actions = [
					{
						action: 'conditional',
						transition: defaultPrototypeTransition,
						branches: [{ condition: { kind: 'literal', value: true }, actions: item.actions }],
					},
				];
			}
			assert.ok(leaf);
		},
	]) {
		const value = raw();
		mutate(value.artifacts[doc.artifactId].objects[a.id].interactions[0]);
		assert.throws(() => parseDesignDocument(JSON.stringify(value)), /prototype|expression/iu);
	}
});

test('Custom springs handle under, critical and over damping, preserve overshoot and derive mass-dependent duration', async () => {
	const { springProgress, prototypeTransitionDuration } = await import('../../contrib/creator/common/model/prototypePlayback.js');
	const base = { mass: 1, stiffness: 100, damping: 8, initialVelocity: 0 };
	assert.equal(springProgress(0, base), 0);
	assert.ok(springProgress(0.35, base) > 1);
	for (const damping of [8, 20, 45]) {
		for (const initialVelocity of [-4, 0, 5]) {
			const spring = { ...base, damping, initialVelocity };
			assert.ok(Number.isFinite(springProgress(0.2, spring)));
			assert.ok(Math.abs(springProgress(20, spring) - 1) < 0.001);
		}
	}
	assert.ok(springProgress(0.05, { ...base, initialVelocity: 5 }) > springProgress(0.05, base));
	const transition = {
		...defaultPrototypeTransition,
		type: 'smart' as const,
		easing: 'spring' as const,
		spring: base,
	};
	const duration = prototypeTransitionDuration(transition);
	assert.ok(duration > 300);
	assert.ok(prototypeTransitionDuration({ ...transition, spring: { ...base, mass: 2 } }) > duration);
	const a = screen('A', [box('Layer', 0)]),
		b = screen('B', [{ ...box('Layer', 100), fill: '#ffffff' }]);
	const sample = samplePrototypeTransition(a, b, transition, 350 / duration)[0].shape as PrototypeFrame;
	assert.ok(sample.children[0].x > 100);
	assert.match(sample.children[0].fill, /^#[0-9a-f]{8}$/u);
	assert.equal(sample.children[0].opacity, 1);
	assert.deepEqual(samplePrototypeTransition(a, b, transition, 1)[0].shape, b);
});

test('Prototype variable dimensions reflow constraints without accumulating geometry changes', () => {
	const resources = prototypeResources(),
		variable = resources.variables[0],
		child = {
			...box('Trailing'),
			x: 70,
			width: 10,
			constraints: { horizontal: 'end' as const, vertical: 'start' as const },
		};
	const a = { ...screen('Home', [child]), width: 100, bindings: { width: variable.id } };
	const player = new PrototypePlayback([a], a.id, resources);
	execute(player, {
		...interaction('back'),
		actions: [
			{
				action: 'setVariable',
				variableId: variable.id,
				value: { kind: 'literal', value: 200 },
				transition: defaultPrototypeTransition,
			},
		],
	});
	assert.equal(player.activeFrame.children[0].x, 170);
	assert.equal(player.scene.children[0].x, 170);
	assert.equal(player.scene.children[0].x, 170);
});

test('Deleting a referenced variable mode leaves a saveable inert action and undo restores the mode', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		resources = prototypeResources(),
		a = screen('Home'),
		collection = resources.collections[0],
		modeId = collection.modes[1].id;
	const trigger: PrototypeInteraction = {
		...interaction('back'),
		actions: [{ action: 'setMode', collectionId: collection.id, modeId, transition: defaultPrototypeTransition }],
	};
	model.replace(
		documentFromShapes([{ ...a, interactions: [trigger] }], {
			documentId: generateUuid(),
			artifactId: generateUuid(),
			resources,
		}),
	);
	commands.resources.deleteMode(collection.id, modeId);
	const saved = serializeDesignDocument(model.value);
	assert.deepEqual(JSON.parse(serializeDesignDocument(parseDesignDocument(saved))), JSON.parse(saved));
	assert.equal([...new PrototypePlayback(model.value.shapes, a.id, model.value.resources).run(trigger)][0].failed, true);
	model.undo();
	assert.equal([...new PrototypePlayback(model.value.shapes, a.id, model.value.resources).run(trigger)][0].failed, undefined);
});

test('Prototype scrolling clamps both axes, separates nested viewports, and chains unused wheel distance', () => {
	const inner = {
		...screen('List', [{ ...box('End'), x: 500, y: 400 }]),
		width: 200,
		height: 100,
		y: 50,
		overflowDirection: 'both' as const,
	};
	const outer = {
		...screen('Page', [inner, { ...box('Footer'), y: 900 }]),
		height: 200,
		overflowDirection: 'vertical' as const,
	};
	const player = new PrototypePlayback([outer], outer.id);
	assert.equal(player.scrollBy(inner.id, { x: 900, y: 600 }), true);
	assert.deepEqual(player.scrollOffset(inner.id), { x: 380, y: 340 });
	assert.deepEqual(player.scrollOffset(outer.id), { x: 0, y: 260 });
	assert.deepEqual([(player.scene.children[0] as PrototypeFrame).children[0].x, (player.scene.children[0] as PrototypeFrame).children[0].y], [120, 60]);
	player.scrollBy(inner.id, { x: -900, y: -1000 });
	assert.deepEqual(player.scrollOffset(inner.id), { x: 0, y: 0 });
	assert.deepEqual(player.scrollOffset(outer.id), { x: 0, y: 0 });
	assert.equal(player.scrollBy(outer.id, { x: 100, y: 0 }), false);
	assert.equal(outer.children[0].y, 50);
});

test('Prototype fixed layers stay above content and sticky layers stop at the viewport and direct parent edges', () => {
	const fixed = { ...box('Fixed'), y: 10, scrollPosition: 'fixed' as const };
	const sticky = { ...box('Sticky'), y: 50, scrollPosition: 'sticky' as const };
	const nestedSticky = { ...box('Nested sticky'), y: 20, scrollPosition: 'sticky' as const };
	const parent = { ...screen('Section', [nestedSticky]), y: 100, height: 300, clip: false };
	const page = {
		...screen('Page', [fixed, sticky, parent, { ...box('Footer'), y: 900 }]),
		height: 200,
		overflowDirection: 'vertical' as const,
	};
	const player = new PrototypePlayback([page], page.id);
	player.scrollBy(page.id, { x: 0, y: 150 });
	const find = (id: string) => flattenDesignShapes([player.scene]).find(shape => shape.id === id)!;
	assert.equal(find(fixed.id).y, 10);
	assert.equal(player.scene.children.at(-1)!.id, fixed.id);
	assert.equal(find(sticky.id).y, 0);
	assert.equal(find(parent.id).y + find(nestedSticky.id).y, 0);
	player.scrollBy(page.id, { x: 0, y: 250 });
	assert.equal(find(sticky.id).y, 0);
	assert.equal(find(parent.id).y + find(nestedSticky.id).y, -40);
	assert.equal(
		player.scene.children.findIndex(shape => shape.id === sticky.id),
		0,
	);
	player.scrollEdge(page.id, false);
	assert.equal(find(sticky.id).y, 50);
	assert.equal(find(nestedSticky.id).y, 20);
});

test('Prototype horizontal scrolling leaves sticky positioning inactive and fixed positioning cancels both axes', () => {
	const sticky = { ...box('Sticky', 80), scrollPosition: 'sticky' as const },
		fixed = { ...box('Fixed', 60), scrollPosition: 'fixed' as const };
	const page = {
		...screen('Horizontal', [sticky, fixed, box('End', 900)]),
		width: 200,
		overflowDirection: 'horizontal' as const,
	};
	const player = new PrototypePlayback([page], page.id);
	player.scrollBy(page.id, { x: 150, y: 500 });
	assert.deepEqual(player.scrollOffset(page.id), { x: 150, y: 0 });
	assert.deepEqual([player.scene.children[0].x, player.scene.children[0].y], [-70, 20]);
	assert.deepEqual([player.scene.children.at(-1)!.x, player.scene.children.at(-1)!.y], [60, 20]);
});

test('Scroll to resolves nested viewports, scaled groups and conditional chains without rewriting authored geometry', async () => {
	const { prototypeScrollTargets } = await import('../../contrib/creator/common/model/prototypeScroll.js');
	const target = { ...box('Target'), x: 20, y: 50 };
	const group: DesignShape = {
		...box('Group'),
		kind: 'group',
		x: 10,
		y: 300,
		width: 200,
		height: 200,
		contentWidth: 100,
		contentHeight: 100,
		children: [target],
	};
	const source = box('Button'),
		page = {
			...screen('Page', [source, group, { ...box('Footer'), y: 1000 }]),
			height: 200,
			overflowDirection: 'vertical' as const,
		};
	assert.equal(
		prototypeScrollTargets([page], source.id).some(shape => shape.id === target.id),
		false,
	);
	assert.equal(
		prototypeScrollTargets([page], source.id, false).some(shape => shape.id === target.id),
		true,
	);
	const player = new PrototypePlayback([page], page.id);
	const action = interaction('scrollTo', target.id, { transition: { ...defaultPrototypeTransition, type: 'scroll' } }).actions[0];
	const chain = {
		...interaction('back'),
		actions: [
			{
				action: 'conditional' as const,
				transition: defaultPrototypeTransition,
				branches: [{ condition: { kind: 'literal' as const, value: true }, actions: [action] }],
			},
		],
	};
	const effect = [...player.run(chain, source.id)][0];
	assert.ok(effect.scroll);
	assert.equal(effect.transition.type, 'scroll');
	assert.equal(player.scrollOffset(page.id).y, 400);
	assert.equal(group.y, 300);
	const inner = {
		...screen('Inner', [{ ...target, y: 300 }]),
		y: 100,
		width: 200,
		height: 100,
		overflowDirection: 'vertical' as const,
	};
	const outer = { ...page, children: [inner, { ...box('Footer'), y: 1000 }] },
		nested = new PrototypePlayback([outer], outer.id);
	execute(nested, interaction('scrollTo', target.id));
	assert.equal(nested.scrollOffset(inner.id).y, 240);
	assert.equal(nested.scrollOffset(outer.id).y, 160);
});

test('Prototype scroll positions survive navigation and snapshots, match frame families, and reset destinations recursively', () => {
	const make = (name: string) => ({
		...screen(name, [
			{ ...screen('List', [{ ...box('Row'), y: 800 }]), height: 100, overflowDirection: 'vertical' as const },
			{ ...box('Footer'), y: 1000 },
		]),
		height: 200,
		overflowDirection: 'vertical' as const,
	});
	const a = make('Checkout / Empty'),
		b = make('Checkout / Complete'),
		c = make('Unrelated');
	const player = new PrototypePlayback([a, b, c], a.id);
	player.scrollBy(a.children[0].id, { x: 0, y: 100 });
	player.scrollBy(a.id, { x: 0, y: 200 });
	const snapshot = player.snapshot();
	execute(player, interaction('navigate', b.id));
	assert.equal(player.scrollOffset(b.id).y, 200);
	assert.equal(player.scrollOffset(b.children[0].id).y, 100);
	execute(player, interaction('navigate', c.id));
	assert.equal(player.scrollOffset(c.id).y, 0);
	execute(player, interaction('back'));
	assert.equal(player.scrollOffset(b.id).y, 200);
	execute(player, interaction('navigate', a.id, { resetScroll: true }));
	assert.equal(player.scrollOffset(a.id).y, 0);
	assert.equal(player.scrollOffset(a.children[0].id).y, 0);
	player.restore(snapshot);
	assert.equal(player.scrollOffset(a.id).y, 200);
	assert.equal(player.scrollOffset(a.children[0].id).y, 100);
	execute(player, interaction('navigate', a.id, { resetScroll: true }));
	assert.equal(player.scrollOffset(a.id).y, 0);
});

test('Scroll settings, deep wires and target deletion save, duplicate and undo through the document owner', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model),
		target = { ...box('End'), y: 900 },
		source = box('Jump'),
		page = { ...screen('Page', [source, target]), height: 200 };
	model.replace(documentFromShapes([page]));
	commands.prototype.setScroll(page.id, { overflowDirection: 'vertical' });
	commands.prototype.setScroll(source.id, { scrollPosition: 'fixed' });
	commands.prototype.connect(new Set([source.id]), target.id);
	const find = (id: string) => flattenDesignShapes(model.value.shapes).find(shape => shape.id === id)!;
	assert.equal(find(source.id).interactions![0].actions[0].action, 'scrollTo');
	assert.equal((find(page.id) as PrototypeFrame).children.at(-1)!.id, source.id);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	const copied = commands.duplicate(new Set([page.id]))[0],
		copy = find(copied) as PrototypeFrame;
	const copiedTarget = copy.children.find(shape => shape.name === 'End')!;
	assert.equal(copy.children.at(-1)!.interactions![0].actions[0].destination, copiedTarget.id);
	commands.removeShapes(new Set([target.id]));
	assert.equal(find(source.id).interactions!.length, 0);
	model.undo();
	assert.equal(find(source.id).interactions![0].actions[0].destination, target.id);
});

test('Auto layout excludes absolute fixed layers from flow and hug sizes and applies their resize constraints', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const normal = { ...box('Row'), height: 60 },
		fixed = {
			...box('Toolbar'),
			x: 120,
			y: 10,
			width: 50,
			constraints: { horizontal: 'end' as const, vertical: 'start' as const },
		};
	const page: PrototypeFrame = {
		...screen('Page', [normal, fixed]),
		width: 200,
		height: 200,
		autoLayout: {
			direction: 'vertical',
			gap: 0,
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			align: 'start',
			justify: 'start',
			width: 'fixed',
			height: 'hug',
		},
	};
	model.replace(documentFromShapes([page]));
	commands.prototype.setScroll(fixed.id, { scrollPosition: 'fixed' });
	assert.equal(flattenDesignShapes(model.value.shapes).find(shape => shape.id === fixed.id)!.scrollPosition, 'scroll');
	commands.prototype.setScroll(fixed.id, { layoutPositioning: 'absolute', scrollPosition: 'fixed' });
	const current = model.value.shapes[0] as PrototypeFrame;
	assert.equal(current.height, 60);
	const old = current.children.find(shape => shape.id === fixed.id)!;
	model.applyEdit([{ ...current, width: 300 }]);
	const resized = (model.value.shapes[0] as PrototypeFrame).children.find(shape => shape.id === fixed.id)!;
	assert.equal(resized.x, old.x + 100);
	commands.prototype.setScroll(fixed.id, { layoutPositioning: 'auto' });
	assert.equal((model.value.shapes[0] as PrototypeFrame).height, 100);
});

test('Scroll file validation rejects unknown directions, object overflow, cross-screen targets and invalid animation types', () => {
	const target = { ...box('End'), y: 900 },
		page = {
			...screen('Page', [target]),
			overflowDirection: 'vertical' as const,
			interactions: [interaction('scrollTo', target.id)],
		},
		other = screen('Other');
	const document = documentFromShapes([page, other]);
	for (const change of [
		(objects: any) => {
			objects[page.id].overflowDirection = 'diagonal';
		},
		(objects: any) => {
			objects[target.id].overflowDirection = 'vertical';
		},
		(objects: any) => {
			objects[target.id].scrollPosition = 'floating';
		},
		(objects: any) => {
			objects[target.id].layoutPositioning = 'relative';
		},
		(objects: any) => {
			objects[page.id].interactions[0].actions[0].destination = other.id;
		},
		(objects: any) => {
			objects[page.id].interactions[0].actions[0].transition.type = 'push';
		},
		(objects: any) => {
			objects[page.id].interactions[0].actions[0].resetScroll = true;
		},
	]) {
		const raw = JSON.parse(serializeDesignDocument(document));
		change(raw.artifacts[document.artifactId].objects);
		assert.throws(() => parseDesignDocument(JSON.stringify(raw)), /prototype/iu);
	}
});

test('Prototype clipping removes offscreen keyboard hotspots and exposes them after scroll', () => {
	const hidden = { ...box('Offscreen'), y: 800, interactions: [interaction('back')] },
		fixed = { ...box('Pinned'), scrollPosition: 'fixed' as const, interactions: [interaction('back')] };
	const page = { ...screen('Page', [hidden, fixed]), height: 200, overflowDirection: 'vertical' as const },
		player = new PrototypePlayback([page], page.id);
	assert.deepEqual(
		player.hotspots.map(shape => shape.name),
		['Pinned'],
	);
	player.scrollEdge(page.id, true);
	assert.deepEqual(
		player.hotspots.map(shape => shape.name),
		['Offscreen', 'Pinned'],
	);
});

test('Scroll to inherited component targets resolves the placed instance and saves source references', () => {
	using model = new DesignModel();
	const commands = new DocumentCommands(model);
	const target = { ...box('End'), y: 900 },
		button = {
			...box('Jump'),
			scrollPosition: 'fixed' as const,
			interactions: [interaction('scrollTo', target.id)],
		};
	const main: PrototypeFrame = {
		...screen('List', [button, target]),
		height: 200,
		overflowDirection: 'vertical',
		component: { kind: 'main' },
	};
	model.replace(documentFromShapes([main]));
	const first = commands.components.createInstance(main.id)!,
		second = commands.components.createInstance(main.id)!;
	const saved = serializeDesignDocument(model.value);
	assert.deepEqual(parseDesignDocument(saved), model.value);
	const player = new PrototypePlayback(model.value.shapes, first),
		source = player.activeFrame.children.find(shape => shape.sourceId === button.id)!;
	execute(player, source.interactions![0], source.id);
	assert.equal(player.scrollOffset(first).y, 740);
	execute(player, interaction('navigate', second));
	assert.equal(player.scrollOffset(second).y, 740); // Same-name screens share positions.
	execute(player, interaction('navigate', first, { resetScroll: true }));
	assert.equal(player.scrollOffset(first).y, 0);
	assert.equal(serializeDesignDocument(model.value), saved);
});

test('Scroll ranges ignore fixed overflow and clipped nested contents; rotated input follows local axes', async () => {
	const { prototypeScrollRange } = await import('../../contrib/creator/common/model/prototypeScroll.js');
	const fixed = { ...box('Fixed'), y: 1000, scrollPosition: 'fixed' as const },
		clipped = { ...screen('Clipped', [{ ...box('Hidden overflow'), y: 2000 }]), height: 100 };
	const page = { ...screen('Page', [fixed, clipped]), height: 200, overflowDirection: 'vertical' as const };
	assert.deepEqual(prototypeScrollRange(page), { x: 0, y: 0 });
	const inner = { ...clipped, rotation: 90, overflowDirection: 'vertical' as const },
		outer = { ...page, children: [inner] },
		player = new PrototypePlayback([outer], outer.id);
	player.scrollBy(inner.id, { x: -80, y: 0 });
	assert.ok(Math.abs(player.scrollOffset(inner.id).y - 80) < 1e-8);
	assert.equal(player.scrollOffset(outer.id).y, 0);
});

test('Moving a scroll target across screens removes the invalid wire and undo restores it', () => {
	using model = new DesignModel();
	const target = { ...box('End'), y: 900 },
		source = { ...box('Jump'), interactions: [interaction('scrollTo', target.id)] };
	const page = { ...screen('Page', [source, target]), overflowDirection: 'vertical' as const },
		other = screen('Other');
	model.replace(documentFromShapes([page, other]));
	model.applyEdit([
		{ ...page, children: [source] },
		{ ...other, children: [target] },
	]);
	assert.equal((model.value.shapes[0] as PrototypeFrame).children[0].interactions!.length, 0);
	assert.deepEqual(parseDesignDocument(serializeDesignDocument(model.value)), model.value);
	model.undo();
	assert.equal((model.value.shapes[0] as PrototypeFrame).children[0].interactions![0].actions[0].destination, target.id);
});
