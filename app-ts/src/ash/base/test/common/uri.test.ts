import { strict as assert } from "node:assert";
import { test } from "mocha";
import { URI } from "../../common/uri.js";

test("URI parses and canonicalizes absolute hierarchical resources", () => {
	const resource = URI.parse("ASH://workspace/a/../An item?rev=1#anchor=3");

	assert.equal(
		resource.toString(),
		"ash://workspace/An%20item?rev=1#anchor=3",
	);
	assert.equal(resource.scheme, "ash");
	assert.equal(resource.authority, "workspace");
	assert.equal(resource.path, "/An%20item");
	assert.equal(resource.query, "rev=1");
	assert.equal(resource.fragment, "anchor=3");
});

test("URI requires an absolute URI and valid percent encoding", () => {
	assert.throws(() => URI.parse("./item.txt"), TypeError);
	assert.throws(() => URI.parse("C:\\Folder\\item.txt"), TypeError);
	assert.throws(() => URI.parse("file:///item%ZZ.txt"), TypeError);
	assert.throws(
		() => URI.parse("https://user:secret@example.com/item"),
		TypeError,
	);
});

test("URI.file supports Windows drive paths and UNC paths", () => {
	const drive = URI.file("C:\\Users\\Ash\\An item.txt");
	const unc = URI.file("\\\\server\\share\\An item.txt");

	assert.equal(drive.toString(), "file:///C:/Users/Ash/An%20item.txt");
	assert.equal(drive.fsPath, "C:\\Users\\Ash\\An item.txt");
	assert.equal(
		unc.toString(),
		"file://server/share/An%20item.txt",
	);
	assert.equal(unc.fsPath, "\\\\server\\share\\An item.txt");
});

test("URI changes are immutable and fragments can be removed explicitly", () => {
	const anchored = URI.parse("ash://workspace/item?rev=2#anchor=7");
	const resource = anchored.withoutFragment();

	assert.equal(anchored.fragment, "anchor=7");
	assert.equal(resource.toString(), "ash://workspace/item?rev=2");
	assert.equal(resource.withQuery("rev=3").query, "rev=3");
	assert.equal(resource.withPath("/renamed").path, "/renamed");
});
