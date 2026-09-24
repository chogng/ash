import { strict as assert } from "node:assert";
import { test } from "mocha";
import { lxiconsLibrary } from "../../common/lxiconsLibrary.js";
import { Icon, register, resolveIconDefinition } from "../../common/icon.js";

let testIconId = 0;

function nextIconId(suffix: string): string {
	testIconId += 1;
	return `test-icon-${testIconId}-${suffix}`;
}

test("registered icons resolve to their renderer definition", () => {
	const definition = () => "<svg></svg>";
	const icon = register(nextIconId("definition"), definition);

	assert.equal(resolveIconDefinition(icon), definition);
});

test("lxicons library entries resolve to repository-owned SVG definitions", () => {
	for (const icon of Object.values(lxiconsLibrary)) {
		const markup = resolveIconDefinition(icon)();
		assert.match(markup, /^<svg\b[^>]*>/);
		assert.match(markup, /<\/svg>$/);
	}
});

test("semantic icons resolve through another icon", () => {
	const definition = () => "<svg></svg>";
	const libraryIcon = register(nextIconId("library"), definition);
	const semanticIcon = register(nextIconId("semantic"), libraryIcon);

	assert.equal(resolveIconDefinition(semanticIcon), definition);
});

test("unknown icon IDs fail at the renderer boundary", () => {
	const id = nextIconId("unknown");

	assert.throws(
		() => resolveIconDefinition(Icon.fromId(id)),
		new ReferenceError(`Unknown icon '${id}'`),
	);
});

test("circular icon defaults report the complete alias chain", () => {
	const firstId = nextIconId("cycle-first");
	const secondId = nextIconId("cycle-second");
	const first = register(firstId, Icon.fromId(secondId));
	register(secondId, first);

	assert.throws(
		() => resolveIconDefinition(first),
		new Error(
			`Circular icon defaults: ${firstId} -> ${secondId} -> ${firstId}`,
		),
	);
});

test("duplicate and malformed icon IDs are rejected", () => {
	const id = nextIconId("duplicate");
	const definition = () => "<svg></svg>";
	register(id, definition);

	assert.throws(() => register(id, definition), TypeError);
	assert.throws(() => register("Not Valid", definition), TypeError);
});
