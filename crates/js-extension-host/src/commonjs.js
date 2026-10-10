/** Loads one captured package without consulting host files after confinement. */
export function loadCommonJS(sources, root, separator, entry, vscode) {
	const cache = new Map();
	const directory = name => name.slice(0, Math.max(0, name.lastIndexOf('/')));
	const filename = name => root.replace(/[\\/]$/, '') + separator + name.split('/').join(separator);
	const source = name => Object.hasOwn(sources, name);
	const normalize = path => {
		const parts = [];
		for (const part of path.split('/')) {
			if (part === '' || part === '.') continue;
			if (part === '..') {
				if (parts.length === 0) throw new Error('Module import escapes its package');
				parts.pop();
			} else parts.push(part);
		}
		return parts.join('/');
	};
	const file = name => [name, name + '.js', name + '.json'].find(source);
	const lookup = (name, visited = new Set()) => {
		const found = file(name);
		if (found !== undefined) return found;
		if (visited.has(name)) return undefined;
		visited.add(name);
		const prefix = name ? name + '/' : '';
		const manifest = prefix + 'package.json';
		if (source(manifest)) {
			const metadata = JSON.parse(sources[manifest].replace(/^\uFEFF/, ''));
			if (typeof metadata.main === 'string' && metadata.main) {
				const main = lookup(normalize(prefix + metadata.main), visited);
				if (main !== undefined) return main;
			}
		}
		return file(prefix + 'index');
	};
	const resolve = (name, referrer) => {
		if (typeof name !== 'string' || !name || name.includes('\0') || name.length > 32768) throw new TypeError('Invalid CommonJS module name');
		if (name === 'vscode') return name;
		if (name.startsWith('node:')) throw new Error('Unsupported extension module: ' + name);
		const request = separator === '\\' ? name.replaceAll('\\', '/') : name;
		const packageRoot = root.replaceAll(separator, '/').replace(/\/$/, '');
		let found;
		if (request.startsWith(packageRoot + '/')) {
			found = lookup(normalize(request.slice(packageRoot.length + 1)));
		} else if (request.startsWith('./') || request.startsWith('../')) {
			found = lookup(normalize(directory(referrer) + '/' + request));
		} else if (!request.startsWith('/') && !request.includes(':') && !request.split('/').some(part => !part || part === '.' || part === '..')) {
			let current = directory(referrer);
			while (true) {
				found = lookup((current ? current + '/' : '') + 'node_modules/' + request);
				if (found !== undefined || !current) break;
				current = directory(current);
			}
		}
		if (found !== undefined) return found;
		const error = new Error("Cannot find module '" + name + "' from '" + filename(referrer) + "'");
		error.code = 'MODULE_NOT_FOUND';
		throw error;
	};
	const load = (name, parent = null) => {
		const retained = cache.get(name);
		if (retained) return retained;
		const module = { id: filename(name), filename: filename(name), exports: {}, loaded: false, parent, children: [] };
		const require = request => {
			const target = resolve(request, name);
			if (target === 'vscode') return vscode;
			const child = load(target, module);
			if (!module.children.includes(child)) module.children.push(child);
			return child.exports;
		};
		require.resolve = request => {
			const target = resolve(request, name);
			return target === 'vscode' ? target : filename(target);
		};
		module.require = require;
		// Publish before evaluating: a cycle observes the same partial exports object.
		cache.set(name, module);
		try {
			const text = sources[name].replace(/^\uFEFF/, '').replace(/^#![^\n]*(?:\n|$)/, '');
			if (name.endsWith('.json')) {
				module.exports = JSON.parse(text);
			} else {
				Function('exports', 'require', 'module', '__filename', '__dirname', text).call(module.exports, module.exports, require, module, module.filename, directory(name) ? filename(directory(name)) : root);
			}
			module.loaded = true;
			return module;
		} catch (error) {
			cache.delete(name);
			throw error;
		}
	};
	return load(entry);
}
