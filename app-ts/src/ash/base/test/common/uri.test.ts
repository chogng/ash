import { strict as assert } from "node:assert";
import { test } from "mocha";
import { isWindows } from '../../common/platform.js';
import { URI } from "../../common/uri.js";

test("URI parses and canonicalizes absolute hierarchical resources", () => {
	const resource = URI.parse("ASH://workspace/a/../An item?rev=1#anchor=3");

	assert.equal(
		resource.toString(),
		"ash://workspace/An%20item?rev=1#anchor=3",
	);
	assert.equal(resource.scheme, "ash");
	assert.equal(resource.authority, "workspace");
	assert.equal(resource.path, "/An item");
	assert.equal(resource.query, "rev=1");
	assert.equal(resource.fragment, "anchor=3");
});

test('URI.parse assigns file to scheme-less input and strict mode requires a scheme', () => {
	assert.equal(URI.parse('./item.txt').toString(), 'file:///item.txt');
	assert.equal(URI.parse('//server/share/item.txt?rev=2#anchor').toString(), 'file://server/share/item.txt?rev=2#anchor');
	assert.equal(URI.parse('?rev=2#anchor').toString(), 'file:///?rev=2#anchor');
	assert.equal(URI.parse('').toString(), 'file:///');
	assert.throws(() => URI.parse('./item.txt', true), /scheme is missing/);
	assert.throws(() => URI.parse('', true), /scheme is missing/);
	assert.throws(() => URI.parse('file:////server/share'), /without an authority/);
});

test('URI.from applies the same scheme rule to decoded components', () => {
	assert.equal(URI.from({ scheme: '', path: 'item.txt' }).toString(), 'file:///item.txt');
	assert.equal(URI.from({ scheme: '', authority: 'server', path: '/share/item.txt' }).toString(), 'file://server/share/item.txt');
	assert.throws(() => URI.from({ scheme: '' }, true), /scheme is missing/);
	assert.throws(() => URI.from({ scheme: '', path: '//server/share' }), /without an authority/);
});

test('URI validates percent encoding and rejects credentials', () => {
	assert.throws(() => URI.parse("file:///item%ZZ.txt"), TypeError);
	assert.throws(() => URI.parse('item%ZZ.txt'), TypeError);
	assert.throws(
		() => URI.parse("https://user:secret@example.com/item"),
		TypeError,
	);
});

test("URI.file supports Windows drive paths and UNC paths", () => {
	assert.equal(URI.file('C:/Users/Ash/An item.txt').toString(), 'file:///C:/Users/Ash/An%20item.txt');
	if (!isWindows) {
		assert.throws(() => URI.file('C:\\Users\\Ash\\An item.txt'), TypeError);
		return;
	}
	const drive = URI.file("C:\\Users\\Ash\\An item.txt");
	const unc = URI.file("\\\\server\\share\\An item.txt");

	assert.equal(drive.toString(), "file:///C:/Users/Ash/An%20item.txt");
	assert.equal(drive.fsPath, isWindows ? "C:\\Users\\Ash\\An item.txt" : 'C:/Users/Ash/An item.txt');
	assert.equal(
		unc.toString(),
		"file://server/share/An%20item.txt",
	);
	assert.equal(unc.fsPath, isWindows ? "\\\\server\\share\\An item.txt" : '//server/share/An item.txt');
});

test('URI.file preserves percent signs and Unicode in file paths', () => {
	if (!isWindows) {
		return;
	}
	const resource = URI.file('C:\\project\\hello %中.txt');
	assert.equal(resource.toString(), 'file:///C:/project/hello%20%25%E4%B8%AD.txt');
	assert.equal(resource.fsPath, isWindows ? 'C:\\project\\hello %中.txt' : 'C:/project/hello %中.txt');
	assert.equal(URI.parse(resource.toString()).fsPath, resource.fsPath);
});

test('URI.file retains a POSIX backslash as part of a file name', () => {
	if (isWindows) {
		return;
	}
	const resource = URI.file('/tmp/a\\b');
	assert.equal(resource.toString(), 'file:///tmp/a%5Cb');
	assert.equal(resource.fsPath, '/tmp/a\\b');
	assert.equal(URI.file('/tmp/C:\\Users\\Ash').fsPath, '/tmp/C:\\Users\\Ash');
});

test('URI serialization retains components and can be revived', () => {
	const original = URI.parse('ash://workspace/a%20b?rev=2#anchor');
	const serialized = JSON.parse(JSON.stringify(original));

	assert.deepEqual(serialized, {
		$mid: 1,
		external: 'ash://workspace/a%20b?rev=2#anchor',
		scheme: 'ash',
		authority: 'workspace',
		path: '/a b',
		query: 'rev=2',
		fragment: 'anchor',
	});
	assert.equal(URI.revive(serialized).toString(), original.toString());
	assert.equal(URI.revive(original), original);
	assert.equal(URI.from({ scheme: 'ash', authority: 'workspace', path: '/a b', query: 'rev=2', fragment: 'anchor' }).toString(), original.toString());
});

test('URI exposes decoded components while preserving escaped path boundaries', () => {
	const resource = URI.parse('ash://workspace/a%2Fb?name=a%26b#x%23y');
	assert.deepEqual([resource.path, resource.query, resource.fragment], ['/a/b', 'name=a&b', 'x#y']);
	assert.deepEqual(resource.toEncodedComponents(), {
		scheme: 'ash', authority: 'workspace', path: '/a%2Fb', query: 'name=a%26b', fragment: 'x%23y',
	});
	assert.equal(URI.revive(JSON.parse(JSON.stringify(resource))).toString(), resource.toString());
});

test('URI.isUri accepts URI behavior and rejects serialized components', () => {
	const resource = URI.file('/workspace/a.txt');
	assert.equal(URI.isUri(resource), true);
	assert.equal(URI.isUri(resource.toJSON()), false);
	assert.equal(URI.isUri({
		scheme: 'file', authority: '', path: '/workspace/a.txt', query: '', fragment: '',
		fsPath: '/workspace/a.txt', with() { return this; }, toString() { return 'file:///workspace/a.txt'; },
	}), true);
	assert.equal(URI.isUri({
		scheme: 'file', authority: '', path: '/workspace/a.txt', query: '', fragment: '',
		fsPath: 1, with() { return this; }, toString() { return 'file:///workspace/a.txt'; },
	}), false);
	assert.equal(URI.isUri('file:///workspace/a.txt'), false);
});

test('URI.with changes decoded components while retaining unchanged encoded boundaries', () => {
	const resource = URI.parse('ash://workspace/a%2Fb?key=a%26b#x%23y');
	assert.equal(resource.with({}), resource);
	assert.equal(resource.with({ query: 'next=中' }).toString(), 'ash://workspace/a%2Fb?next=%E4%B8%AD#x%23y');
	assert.equal(resource.with({ query: null, fragment: null }).toString(), 'ash://workspace/a%2Fb');
	assert.equal(resource.with({ scheme: 'other', authority: 'host', path: '/new ?#' }).toString(), 'other://host/new%20%3F%23?key=a%26b#x%23y');
	assert.throws(() => resource.with({ authority: 'host', path: 'relative' }), TypeError);
});

test('URI.toString(true) uses minimal component encoding', () => {
	const resource = URI.from({ scheme: 'ash', authority: 'workspace', path: '/é?中#', query: 'q=é#中', fragment: 'x#中' });
	assert.equal(resource.toString(), 'ash://workspace/%C3%A9%3F%E4%B8%AD%23?q=%C3%A9%23%E4%B8%AD#x%23%E4%B8%AD');
	assert.equal(resource.toString(true), 'ash://workspace/é%3F中%23?q=é%23中#x#中');
});

test('URI.joinPath resolves fragments and preserves query and fragment', () => {
	const root = URI.parse('ash://workspace/project/src?rev=2#anchor');
	const child = URI.joinPath(root, '..', 'a b.txt');

	assert.equal(child.toString(), 'ash://workspace/project/a%20b.txt?rev=2#anchor');
	assert.equal(root.joinPathSegment('a/b?.txt').toString(), 'ash://workspace/project/src/a%2Fb%3F.txt?rev=2#anchor');
	assert.equal(URI.joinPath(URI.parse('ash://workspace/a%2Fb'), 'child').toString(), 'ash://workspace/a%2Fb/child');
});

test('URI.fsPath keeps slash-separated workspace paths', () => {
	const resource = URI.file('/workspace/a b.txt');
	assert.equal(resource.fsPath, '/workspace/a b.txt');
});

test("URI changes are immutable and fragments can be removed explicitly", () => {
	const anchored = URI.parse("ash://workspace/item?rev=2#anchor=7");
	const resource = anchored.with({ fragment: null });

	assert.equal(anchored.fragment, "anchor=7");
	assert.equal(resource.toString(), "ash://workspace/item?rev=2");
	assert.equal(resource.with({ query: 'rev=3' }).query, 'rev=3');
	assert.equal(resource.with({ path: '/renamed' }).path, '/renamed');
});

test('URI.with encodes a decoded path and keeps the other components', () => {
	const parent = URI.parse("ash://workspace/root?rev=2#anchor");
	const child = parent.with({ path: '/root/hello world.txt' });

	assert.equal(child.toString(), "ash://workspace/root/hello%20world.txt?rev=2#anchor");
	assert.equal(parent.toString(), "ash://workspace/root?rev=2#anchor");
	assert.equal(parent.with({ path: '/root/bad%ZZ.txt' }).toString(), 'ash://workspace/root/bad%25ZZ.txt?rev=2#anchor');
});

test("URI.joinPathSegment preserves components and encodes one child name", () => {
	const parent = URI.parse("ash://workspace/root?rev=2#anchor");
	const child = parent.joinPathSegment("hello %中?#.txt");
	assert.equal(child.toString(), "ash://workspace/root/hello%20%25%E4%B8%AD%3F%23.txt?rev=2#anchor");
	assert.deepEqual([child.scheme, child.authority, child.path, child.query, child.fragment], ["ash", "workspace", "/root/hello %中?#.txt", "rev=2", "anchor"]);
	assert.equal(URI.file("/tmp/root/").joinPathSegment("a b").toString(), "file:///tmp/root/a%20b");
	assert.equal(URI.file("/tmp/root").joinPathSegment("..").toString(), "file:///tmp/");
	const directories = [
		...(isWindows ? [URI.file("C:\\project\\src"), URI.file("\\\\server\\share\\src")] : []),
		URI.parse("vscode-remote://ssh-remote+host/workspace?rev=1#anchor"),
	];
	for (const directory of directories) {
		for (const name of ["plain.txt", "a % 中.txt", "question?#.txt"]) {
			const base = directory.path.endsWith("/") ? directory.path.slice(0, -1) : directory.path;
			assert.equal(directory.joinPathSegment(name).toString(), directory.with({ path: `${base}/${name}` }).toString());
		}
	}
});
