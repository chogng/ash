// Run in the shipped Electron runtime, with dependencies resolved only from the relocated app.
const assert = require('node:assert/strict');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { createRequire, isBuiltin } = require('node:module');
const { isAbsolute, join, relative, sep } = require('node:path');

const root = realpathSync(process.argv[2]);
const { lock, electron } = JSON.parse(readFileSync(process.argv[3], 'utf8'));
assert.equal(process.versions.electron, electron);
const appRequire = createRequire(join(root, 'package.json'));
const dependencies = [];
const visited = new Set();
const pending = [];

function insideApp(path) {
	const physical = realpathSync(path);
	const difference = relative(root, physical);
	assert(!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`), `Dependency escapes delivered app: ${path}`);
	return physical;
}

function matches(values, actual) {
	return !values || !values.includes(`!${actual}`)
		&& (values.every(value => value.startsWith('!')) || values.includes(actual) || values.includes('any'));
}

function enqueue(from, snapshot, importer = false) {
	for (const kind of ['dependencies', 'optionalDependencies']) {
		for (const [name, dependency] of Object.entries(snapshot[kind] || {})) {
			pending.push({ from, name, version: importer ? dependency.version : dependency, optional: kind === 'optionalDependencies' });
		}
	}
}

enqueue(root, lock.importers['.'], true);
while (pending.length) {
	const { from, name, version, optional } = pending.shift();
	// pnpm records an aliased dependency as actual-name@version, with peer variants in parentheses.
	const key = /^\d/.test(version) ? `${name}@${version}` : version;
	const packageKey = key.split('(')[0];
	const metadata = lock.packages[packageKey];
	assert(metadata, `Missing locked package ${key}`);
	const compatible = matches(metadata.os, process.platform) && matches(metadata.cpu, process.arch);
	if (optional && !compatible) continue;
	assert(compatible, `Incompatible required package ${key}`);
	const fromRequire = createRequire(join(from, 'package.json'));
	// Reading the manifest through Node's lookup paths also supports packages whose
	// exports hide package.json, and type/data-only packages without a JS entrypoint.
	const location = fromRequire.resolve.paths(`${name}/package.json`).map(path => join(path, name))
		.find(path => existsSync(join(path, 'package.json')));
	assert(location, `Cannot resolve locked dependency ${name} from ${from}`);
	const physical = insideApp(location);
	const manifest = JSON.parse(readFileSync(insideApp(join(physical, 'package.json')), 'utf8'));
	assert.equal(manifest.name, packageKey.slice(0, packageKey.lastIndexOf('@')), `Wrong package for ${name} from ${from}`);
	assert.equal(manifest.version, packageKey.slice(packageKey.lastIndexOf('@') + 1), `Wrong version of ${name} from ${from}`);
	if (!isBuiltin(name) && (manifest.main || manifest.exports || existsSync(join(physical, 'index.js')))) {
		insideApp(fromRequire.resolve(name));
	}
	const identity = `${physical}\0${key}`;
	if (visited.has(identity)) continue;
	visited.add(identity);
	dependencies.push({ name, version: manifest.version, path: physical });
	assert(lock.snapshots[key], `Missing locked snapshot ${key}`);
	enqueue(physical, lock.snapshots[key]);
}

// Exercise JS loading and a Node-API native package as well as resolving manifests.
for (const name of ['fontkit', 'katex', 'koffi']) insideApp(appRequire.resolve(name));
assert.equal(typeof appRequire('fontkit').create, 'function');
assert.match(appRequire('katex').renderToString('x^2'), /katex/);
assert.equal(typeof appRequire('koffi').load, 'function');
const bindings = [];
for (const [name, binary, exports] of [
	['native-keymap', 'keymapping.node', ['getKeyMap', 'getCurrentKeyboardLayout', 'onDidChangeKeyboardLayout']],
	...(process.platform === 'win32' ? [['native-is-elevated', 'iselevated.node', ['isElevated']]] : []),
]) {
	// Both JS wrappers swallow binding-load errors, so load the binary directly.
	const binding = appRequire(insideApp(join(root, 'node_modules', name, 'build/Release', binary)));
	for (const member of exports) assert.equal(typeof binding[member], 'function', `${name}.${member}`);
	bindings.push(name);
}
for (const name of ['.pnpm', '.bin', 'electron', 'typescript']) {
	assert(!existsSync(join(root, 'node_modules', name)), `Development dependency or private pnpm data shipped: ${name}`);
}
console.log(JSON.stringify({ dependencies, bindings }));
