import { strict as assert } from "node:assert";
import { test } from "mocha";
import { ResourceMap, ResourceSet } from "../../common/map.js";
import {
	ExtUri,
	extUri,
	DataUri,
	ResourcePathCasing,
} from "../../common/resources.js";
import { URI } from "../../common/uri.js";

const caseInsensitiveExtUri = new ExtUri(
	() => ResourcePathCasing.Insensitive,
);

test("DataUri reads encoded metadata without consuming the payload", () => {
	const resource = URI.parse("data:text/typescript;label:Demo%20File.ts;description:Part%3BOne;base64,AA");

	assert.deepEqual([...DataUri.parseMetaData(resource)], [
		[DataUri.META_DATA_MIME, "text/typescript"],
		[DataUri.META_DATA_LABEL, "Demo File.ts"],
		["description", "Part;One"],
	]);
	assert.deepEqual([...DataUri.parseMetaData(URI.parse("data:text/plain,content"))], [
		[DataUri.META_DATA_MIME, "text/plain"],
	]);
});

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

test('ExtUri compares URI parents at path segment boundaries', () => {
	const root = URI.parse('ash://workspace/project');
	const child = URI.parse('ash://workspace/project/src/file.ts');

	assert.equal(extUri.isEqualOrParent(child, root), true);
	assert.equal(extUri.isEqualOrParent(root, child), false);
	assert.equal(extUri.isEqualOrParent(URI.parse('ash://workspace/project-next/file.ts'), root), false);
	assert.equal(extUri.isEqualOrParent(URI.parse('ash://other/project/file.ts'), root), false);
	assert.equal(extUri.isEqualOrParent(child, URI.parse('file:///project')), false);
	assert.equal(extUri.isEqualOrParent(child, URI.parse('ash://workspace/project/')), true);
});

test('ExtUri applies URI identity and casing rules to parent paths', () => {
	const root = URI.parse('ash://workspace/Project?revision=1#anchor');
	const child = URI.parse('ash://workspace/Project/src/file.ts?revision=1#anchor');

	assert.equal(extUri.isEqualOrParent(child, root), true);
	assert.equal(extUri.isEqualOrParent(child.withFragment('other'), root), false);
	assert.equal(extUri.isEqualOrParent(child.withFragment('other'), root, true), true);
	assert.equal(extUri.isEqualOrParent(child.withQuery('revision=2'), root), false);
	assert.equal(extUri.isEqualOrParent(URI.parse('ash://workspace/project/src/file.ts?revision=1#anchor'), root), false);
	assert.equal(caseInsensitiveExtUri.isEqualOrParent(URI.parse('ash://workspace/project/src/file.ts?revision=1#anchor'), root), true);
	assert.equal(extUri.isEqualOrParent(URI.parse('ash://workspace/Project%2Fsrc/file.ts?revision=1#anchor'), root), false);
	assert.equal(caseInsensitiveExtUri.isEqual(URI.parse('ash://workspace/a%2Fb'), URI.parse('ash://workspace/a/b')), false);
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
