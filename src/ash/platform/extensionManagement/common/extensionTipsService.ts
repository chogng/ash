import bundledTips from '../../../../../resources/extension-recommendations.json' with { type: 'json' };

export interface ProductExtensionTip {
	readonly id: string;
	readonly name: string;
}
export interface ExecutableExtensionTip extends ProductExtensionTip {
	readonly executables: readonly string[];
	readonly important: boolean;
}
export interface ExtensionTips {
	readonly editors: readonly {
		readonly extensions: readonly string[];
		readonly id: string;
		readonly kind: 'docs' | 'pdf';
		readonly query: string;
	}[];
	readonly projects: readonly { readonly filename: string; readonly language: string }[];
	readonly executables: readonly ExecutableExtensionTip[];
	readonly keymaps: readonly ProductExtensionTip[];
	readonly remote: readonly ProductExtensionTip[];
	readonly web: readonly ProductExtensionTip[];
}

/** Validates product-owned release data once, without accepting paths or executable commands from extensions. */
export function readExtensionTips(value: unknown): ExtensionTips {
	const record = (value: unknown): Record<string, unknown> => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError('Invalid extension recommendation catalog');
		}
		if ('targets' in value || 'uiTargets' in value) {
			throw new TypeError('UI targets belong to package manifests, not recommendation rules');
		}
		return value as Record<string, unknown>;
	};
	const entries = (value: unknown): Record<string, unknown>[] => {
		if (!Array.isArray(value) || value.length > 100) {
			throw new TypeError('Invalid extension recommendation catalog entries');
		}
		return value.map(record);
	};
	const text = (value: unknown, pattern = /^.{1,256}$/u): string => {
		if (typeof value !== 'string' || !pattern.test(value)) {
			throw new TypeError('Invalid extension recommendation catalog value');
		}
		return value;
	};
	const tip = (entry: Record<string, unknown>): ProductExtensionTip => ({
		id: text(entry.id, /^[a-z0-9][a-z0-9._/-]*@[a-z0-9_.-]+$/u),
		name: text(entry.name),
	});
	const root = record(value);
	if (
		root.schemaVersion !== 1 ||
		Object.keys(root).some(
			key => !['schemaVersion', 'editors', 'projects', 'executables', 'keymaps', 'remote', 'web'].includes(key),
		)
	) {
		throw new TypeError('Unsupported extension recommendation catalog');
	}
	return {
		editors: entries(root.editors).map(entry => {
			if (
				!Array.isArray(entry.extensions) ||
				!entry.extensions.length ||
				!['docs', 'pdf'].includes(String(entry.kind))
			) {
				throw new TypeError('Invalid editor recommendation');
			}
			return {
				extensions: entry.extensions.map(value => text(value, /^\.[a-z0-9.-]+$/u)),
				id: tip({ ...entry, name: entry.kind }).id,
				kind: entry.kind as 'docs' | 'pdf',
				query: text(entry.query),
			};
		}),
		projects: entries(root.projects).map(entry => ({
			filename: text(entry.filename, /^[a-zA-Z0-9_.-]+$/u),
			language: text(entry.language, /^[a-z0-9][a-z0-9._-]*$/u),
		})),
		executables: entries(root.executables).map(entry => {
			if (
				!Array.isArray(entry.executables) ||
				!entry.executables.length ||
				entry.executables.length > 10 ||
				typeof entry.important !== 'boolean'
			) {
				throw new TypeError('Invalid executable recommendation');
			}
			return {
				...tip(entry),
				executables: entry.executables.map(value => text(value, /^[a-z0-9][a-z0-9._-]{0,63}$/u)),
				important: entry.important,
			};
		}),
		keymaps: entries(root.keymaps).map(tip),
		remote: entries(root.remote).map(tip),
		web: entries(root.web).map(tip),
	};
}

export const extensionTips = readExtensionTips(bundledTips);
