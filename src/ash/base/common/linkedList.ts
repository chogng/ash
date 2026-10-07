interface LinkedListNode<T> {
	readonly value: T;
	previous: LinkedListNode<T> | undefined;
	next: LinkedListNode<T> | undefined;
	attached: boolean;
}

/** An insertion-ordered list whose entries can be removed in constant time. */
export class LinkedList<T> implements Iterable<T> {
	private firstNode: LinkedListNode<T> | undefined;
	private lastNode: LinkedListNode<T> | undefined;
	private mutableSize = 0;

	get size(): number {
		return this.mutableSize;
	}

	isEmpty(): boolean {
		return this.mutableSize === 0;
	}

	clear(): void {
		let node = this.firstNode;
		while (node) {
			const next = node.next;
			node.previous = undefined;
			node.next = undefined;
			node.attached = false;
			node = next;
		}
		this.firstNode = undefined;
		this.lastNode = undefined;
		this.mutableSize = 0;
	}

	unshift(value: T): () => void {
		return this.insert(value, false);
	}

	push(value: T): () => void {
		return this.insert(value, true);
	}

	shift(): T | undefined {
		const node = this.firstNode;
		if (!node) return undefined;
		this.remove(node);
		return node.value;
	}

	pop(): T | undefined {
		const node = this.lastNode;
		if (!node) return undefined;
		this.remove(node);
		return node.value;
	}

	peek(): T | undefined {
		return this.lastNode?.value;
	}

	*[Symbol.iterator](): Iterator<T> {
		let node = this.firstNode;
		while (node) {
			yield node.value;
			do {
				node = node.next;
			} while (node && !node.attached);
		}
	}

	private insert(value: T, atEnd: boolean): () => void {
		const node: LinkedListNode<T> = {
			value,
			previous: undefined,
			next: undefined,
			attached: true,
		};
		if (!this.firstNode) {
			this.firstNode = node;
			this.lastNode = node;
		} else if (atEnd) {
			node.previous = this.lastNode;
			this.lastNode!.next = node;
			this.lastNode = node;
		} else {
			node.next = this.firstNode;
			this.firstNode.previous = node;
			this.firstNode = node;
		}
		this.mutableSize += 1;
		return () => this.remove(node);
	}

	private remove(node: LinkedListNode<T>): void {
		if (!node.attached) return;
		if (node.previous) node.previous.next = node.next;
		else this.firstNode = node.next;
		if (node.next) node.next.previous = node.previous;
		else this.lastNode = node.previous;
		node.attached = false;
		this.mutableSize -= 1;
	}
}
