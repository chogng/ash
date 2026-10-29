import { extUri, type IExtUri, basename } from './resources.js';
import { URI } from './uri.js';

export interface IResourceNode<T, C = void> {
	readonly uri: URI;
	readonly relativePath: string;
	readonly name: string;
	readonly element: T | undefined;
	readonly children: Iterable<IResourceNode<T, C>>;
	readonly childrenCount: number;
	readonly parent: IResourceNode<T, C> | undefined;
	readonly context: C;
	get(childName: string): IResourceNode<T, C> | undefined;
}

class ResourceNode<T, C> implements IResourceNode<T, C> {
	public readonly entries = new Map<string, ResourceNode<T, C>>();
	public element: T | undefined;

	constructor(
		public readonly uri: URI,
		public readonly relativePath: string,
		public readonly context: C,
		public readonly parent: ResourceNode<T, C> | undefined,
		private readonly identity: IExtUri,
	) { }

	public get name(): string { return this.parent ? basename(this.uri) : ''; }
	public get children(): Iterable<ResourceNode<T, C>> { return this.entries.values(); }
	public get childrenCount(): number { return this.entries.size; }

	public get(childName: string): ResourceNode<T, C> | undefined {
		for (const child of this.entries.values()) {
			const ignoreCase = this.identity.ignorePathCasing(child.uri);
			if (ignoreCase ? child.name.toLowerCase() === childName.toLowerCase() : child.name === childName) {
				return child;
			}
		}
		return undefined;
	}
}

/** A path hierarchy within one URI root. URI identity includes scheme, authority, query and fragment. */
export class ResourceTree<T extends NonNullable<unknown>, C> {
	private readonly rootNode: ResourceNode<T, C>;
	public readonly root: IResourceNode<T, C>;

	constructor(context: C, rootURI: URI = URI.file('/'), private readonly identity: IExtUri = extUri) {
		this.rootNode = new ResourceNode(rootURI, '', context, undefined, identity);
		this.root = this.rootNode;
	}

	public add(uri: URI, element: T): void {
		if (!this.identity.isEqualOrParent(uri, this.root.uri)) {
			throw new RangeError('Resource must belong to the tree URI root');
		}
		let node = this.rootNode;
		for (const resource of this.ancestors(uri)) {
			const key = this.identity.getComparisonKey(resource);
			let child = node.entries.get(key);
			if (!child) {
				const relativePath = `${node.relativePath}/${basename(resource)}`;
				child = new ResourceNode(resource, relativePath, this.root.context, node, this.identity);
				node.entries.set(key, child);
			}
			node = child;
		}
		node.element = element;
	}

	public getNode(uri: URI): IResourceNode<T, C> | undefined {
		if (!this.identity.isEqualOrParent(uri, this.root.uri)) {
			return undefined;
		}
		let node = this.rootNode;
		for (const resource of this.ancestors(uri)) {
			const child = node.entries.get(this.identity.getComparisonKey(resource));
			if (!child) {
				return undefined;
			}
			node = child;
		}
		return node;
	}

	/** Removes the target subtree, retaining ancestors that still carry data or children. */
	public delete(uri: URI): T | undefined {
		const target = this.getNode(uri) as ResourceNode<T, C> | undefined;
		if (!target) {
			return undefined;
		}
		let node: ResourceNode<T, C> = target;
		const element = node.element;
		if (node === this.rootNode) {
			this.clear();
			return element;
		}
		while (node.parent) {
			const parent: ResourceNode<T, C> = node.parent;
			parent.entries.delete(this.identity.getComparisonKey(node.uri));
			if (parent.element !== undefined || parent.childrenCount > 0) {
				break;
			}
			node = parent;
		}
		return element;
	}

	public clear(): void {
		this.rootNode.entries.clear();
		this.rootNode.element = undefined;
	}

	public static getRoot<T, C>(node: IResourceNode<T, C>): IResourceNode<T, C> {
		while (node.parent) {
			node = node.parent;
		}
		return node;
	}

	public static collect<T, C>(node: IResourceNode<T, C>): T[] {
		const result: T[] = [];
		const pending = [node];
		while (pending.length) {
			const current = pending.pop()!;
			if (current.element !== undefined) {
				result.push(current.element);
			}
			for (const child of [...current.children].reverse()) {
				pending.push(child);
			}
		}
		return result;
	}

	public static isResourceNode<T, C>(obj: unknown): obj is IResourceNode<T, C> {
		return obj instanceof ResourceNode;
	}

	private ancestors(uri: URI): URI[] {
		const rootDepth = this.root.uri.toEncodedComponents().path.replace(/\/+$/u, '').split('/').length;
		const segments = uri.toEncodedComponents().path.replace(/\/+$/u, '').split('/');
		const result: URI[] = [];
		// Split the encoded path so escaped slashes stay in their segment and drive roots remain below '/'.
		for (let depth = rootDepth + 1; depth <= segments.length; depth++) {
			result.push(depth === segments.length ? uri : uri.withEncodedPath(segments.slice(0, depth).join('/')));
		}
		return result;
	}
}
