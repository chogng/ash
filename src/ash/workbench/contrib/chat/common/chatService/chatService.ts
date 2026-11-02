import { Schemas } from '../../../../../base/common/network.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import type { ThreadItem, ThreadTranscriptEntry, Turn } from '../../../../../platform/agentHost/common/agent.js';

/** An inert resource tree carried by a response or structured tool-result snapshot. */
export interface IChatResponseProgressFileTreeData {
	readonly label: string;
	readonly uri: URI;
	readonly type?: FileKind;
	readonly children?: readonly IChatResponseProgressFileTreeData[];
}

export interface IChatTreeData {
	readonly treeData: IChatResponseProgressFileTreeData;
	readonly kind: 'treeData';
}

/** Revives the response tree contract at the untrusted structured-content boundary. */
export function reviveChatTreeData(json: string): IChatTreeData | undefined {
	if (json.length > 262_144) return undefined;
	const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
	let count = 0;
	const identities = new Set<string>();
	const read = (value: unknown, depth: number, parent?: URI): IChatResponseProgressFileTreeData | undefined => {
		if (++count > 1000 || depth > 32 || !record(value)
			|| typeof value.label !== 'string' || !value.label.trim() || value.label.length > 512
			|| typeof value.uri !== 'string') return undefined;
		const type = value.type;
		if (type !== undefined && type !== FileKind.Directory && type !== FileKind.File) return undefined;
		if (value.children !== undefined && (!Array.isArray(value.children) || type === FileKind.File)) return undefined;
		let uri: URI;
		try { uri = URI.parse(value.uri); } catch { return undefined; }
		if ((uri.scheme !== Schemas.file && uri.scheme !== Schemas.ashRemote)
			|| uri.query || uri.fragment || !uri.path.startsWith('/')
			|| uri.path.split('/').some(segment => segment === '.' || segment === '..')) return undefined;
		if (parent && (!extUri.isEqualOrParent(uri, parent) || extUri.isEqual(uri, parent))) return undefined;
		const identity = uri.toString();
		if (identities.has(identity)) return undefined;
		identities.add(identity);
		let children: IChatResponseProgressFileTreeData[] | undefined;
		if (Array.isArray(value.children)) {
			children = [];
			for (const child of value.children) {
				const entry = read(child, depth + 1, uri);
				if (!entry) return undefined;
				children.push(entry);
			}
		}
		return { label: value.label, uri, type: children ? FileKind.Directory : type, ...(children ? { children } : {}) };
	};
	try {
		const value: unknown = JSON.parse(json);
		if (!record(value) || value.kind !== 'treeData') return undefined;
		const treeData = read(value.treeData, 0);
		return treeData ? { kind: 'treeData', treeData } : undefined;
	} catch { return undefined; }
}

/**
 * Read-only tool evidence projected from the canonical Thread transcript.
 * A closed Turn without a result remains stopped, never successful. Only the interaction owner
 * may answer an approval; this snapshot carries its kind for presentation, not reply authority.
 */
export interface IChatToolInvocation {
	readonly call: Extract<ThreadItem, { readonly type: 'toolCall'; }>;
	readonly result?: Extract<ThreadItem, { readonly type: 'toolResult'; }>;
	readonly output: readonly Extract<ThreadTranscriptEntry, { readonly type: 'toolOutput'; }>[];
	readonly stopped: boolean;
	readonly waitingFor?: NonNullable<Turn['pendingInteraction']>['kind'];
	readonly executionStarted?: boolean;
}
