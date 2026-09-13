import { strict as assert } from "node:assert";
import { test } from "mocha";
import { ResourceMap, ResourceSet } from "../../common/map.js";
import {
	ExtUri,
	extUri,
	ResourcePathCasing,
} from "../../common/resources.js";
import { URI } from "../../common/uri.js";

const caseInsensitiveExtUri = new ExtUri(
	() => ResourcePathCasing.Insensitive,
);

test("ExtUri preserves fragments unless explicitly ignored", () => {
	const firstAnchor = URI.parse("ash://workspace/item?rev=2#anchor=1");
	const secondAnchor = URI.parse("ash://workspace/item?rev=2#anchor=2");

	assert.equal(extUri.isEqual(firstAnchor, secondAnchor), false);
	assert.equal(
		extUri.isEqualIgnoringFragment(firstAnchor, secondAnchor),
		true,
	);
});

test("ExtUri retains query revisions", () => {
	const first = URI.parse("ash://workspace/item?rev=1#anchor");
	const second = URI.parse("ash://workspace/item?rev=2#anchor");

	assert.equal(extUri.isEqualIgnoringFragment(first, second), false);
});

test("ExtUri normalizes URI spelling under an explicit casing policy", () => {
	const first = URI.parse("file:///C:/Folder/%69tem.txt");
	const second = URI.parse("FILE:///c:/folder/Item.txt");

	assert.equal(extUri.isEqual(first, second), false);
	assert.equal(caseInsensitiveExtUri.isEqual(first, second), true);
});

test("ResourceMap uses exact URI identity by default", () => {
	const firstAnchor = URI.parse("ash://workspace/item#anchor=1");
	const secondAnchor = URI.parse("ash://workspace/item#anchor=2");
	const map = new ResourceMap<string>();

	map.set(firstAnchor, "first");
	map.set(secondAnchor, "second");

	assert.equal(map.size, 2);
	assert.equal(map.get(firstAnchor), "first");
	assert.equal(map.get(secondAnchor), "second");
});

test("ResourceMap and ResourceSet accept explicit content identity", () => {
	const firstAnchor = URI.parse("ash://workspace/item#anchor=1");
	const secondAnchor = URI.parse("ash://workspace/item#anchor=2");
	const toContentKey = extUri.getComparisonKeyIgnoringFragment.bind(extUri);
	const map = new ResourceMap<string>(toContentKey);
	const set = new ResourceSet(toContentKey);

	map.set(firstAnchor, "open");
	set.add(firstAnchor).add(secondAnchor);

	assert.equal(map.get(secondAnchor), "open");
	assert.equal(map.size, 1);
	assert.equal(set.size, 1);
});
