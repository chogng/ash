/** Minimal application-facing identity and focus contract for one Workbench window. */
export interface IWorkbenchWindowRecord {
	readonly id: number;
	workspaceId: string;
	isDestroyed(): boolean;
	focus(): void;
}

/** Tracks live Workbench windows without owning their product resources. */
export class WorkbenchWindowRegistry<T extends IWorkbenchWindowRecord> {
	private readonly records = new Map<number, T>();
	private readonly openings = new Map<string, Promise<T | undefined>>();
	private activationOrder: number[] = [];

	openWorkspace(workspaceId: string, create: () => Promise<T | undefined>): Promise<T | undefined> {
		const pending = this.openings.get(workspaceId);
		if (pending) return pending;
		const existing = this.findWorkspace(workspaceId);
		if (existing) {
			existing.focus();
			return Promise.resolve(existing);
		}
		const operation = create();
		this.openings.set(workspaceId, operation);
		void operation.finally(() => {
			if (this.openings.get(workspaceId) === operation) this.openings.delete(workspaceId);
		}).catch(() => {
			// The caller observes the original operation; this branch settles finally().
		});
		return operation;
	}

	add(record: T): void {
		if (this.records.has(record.id)) throw new Error(`Workbench window ${record.id} is already registered`);
		this.records.set(record.id, record);
		this.activate(record.id);
	}

	remove(id: number): T | undefined {
		const record = this.records.get(id);
		if (!record) return undefined;
		this.records.delete(id);
		this.activationOrder = this.activationOrder.filter(candidate => candidate !== id);
		return record;
	}

	activate(id: number): void {
		if (!this.records.has(id)) throw new Error(`Workbench window ${id} is not registered`);
		this.activationOrder = this.activationOrder.filter(candidate => candidate !== id);
		this.activationOrder.push(id);
	}

	updateWorkspace(id: number, workspaceId: string): void {
		const record = this.records.get(id);
		if (!record) throw new Error(`Workbench window ${id} is not registered`);
		record.workspaceId = workspaceId;
	}

	findWorkspace(workspaceId: string): T | undefined {
		for (let index = this.activationOrder.length - 1; index >= 0; index -= 1) {
			const record = this.records.get(this.activationOrder[index]!);
			if (record && !record.isDestroyed() && record.workspaceId === workspaceId) return record;
		}
		return undefined;
	}

	active(): T | undefined {
		for (let index = this.activationOrder.length - 1; index >= 0; index -= 1) {
			const record = this.records.get(this.activationOrder[index]!);
			if (record && !record.isDestroyed()) return record;
		}
		return undefined;
	}

	focusActive(): boolean {
		const record = this.active();
		if (!record) return false;
		record.focus();
		return true;
	}

	values(): readonly T[] {
		return [...this.records.values()].filter(record => !record.isDestroyed());
	}

	get size(): number {
		return this.values().length;
	}
}
