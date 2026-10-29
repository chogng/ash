import { Disposable, toDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import { canceled } from '../../../../base/common/errors.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type {
	AgentHostResourceSnapshot,
	IAgentHostResourceService,
} from '../../../../platform/agentHost/common/agentHostResourceService.js';

interface Snapshot {
	readonly bytes: Uint8Array;
	readonly expires: number;
	cursor: number;
	reads: number;
}

/** Owns immutable attachment transfer leases; it never reads or grants access to a filesystem path. */
export class AgentHostResourceService extends Disposable implements IAgentHostResourceService {
	private readonly snapshots = new Map<string, Snapshot>();
	private epoch = 0;

	constructor(private readonly now: () => number = Date.now) {
		super();
	}

	public async createSnapshot(content: string): Promise<IReference<AgentHostResourceSnapshot> | undefined> {
		this.assertNotDisposed();
		this.expire();
		const bytes = new TextEncoder().encode(content);
		// Larger legacy contexts retain their existing inline transport contract.
		if (!bytes.length || bytes.length > 8 * 1024 * 1024 || !this.hasCapacity(bytes.byteLength)) {
			return undefined;
		}
		const epoch = this.epoch;
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		if (this.isDisposed || epoch !== this.epoch) {
			throw canceled();
		}
		if (!this.hasCapacity(bytes.byteLength)) {
			return undefined;
		}
		const handle = generateUuid();
		const object = Object.freeze({
			handle,
			byteLength: bytes.byteLength,
			sha256: `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`,
		});
		this.snapshots.set(handle, { bytes, expires: this.now() + 120_000, cursor: 0, reads: 0 });
		return { object, ...toDisposable(() => this.release(handle)) };
	}

	public read(
		handle: string,
		offset: number,
		maximum: number,
	): { readonly bytes: Uint8Array; readonly eof: boolean } {
		this.assertNotDisposed();
		this.expire();
		const snapshot = this.snapshots.get(handle);
		if (
			!snapshot ||
			snapshot.reads >= 64 ||
			!Number.isSafeInteger(offset) ||
			offset !== snapshot.cursor ||
			!Number.isSafeInteger(maximum) ||
			maximum < 1 ||
			maximum > 256 * 1024 ||
			offset >= snapshot.bytes.byteLength
		) {
			throw new ReferenceError('Renderer context snapshot is unavailable');
		}
		const bytes = snapshot.bytes.slice(offset, offset + maximum);
		snapshot.cursor += bytes.byteLength;
		snapshot.reads++;
		return { bytes, eof: snapshot.cursor === snapshot.bytes.byteLength };
	}

	public release(handle: string): void {
		this.snapshots.delete(handle);
	}

	public connectionClosed(): void {
		this.epoch++;
		this.snapshots.clear();
	}

	private hasCapacity(bytes: number): boolean {
		return (
			this.snapshots.size < 64 &&
			[...this.snapshots.values()].reduce((total, snapshot) => total + snapshot.bytes.byteLength, 0) + bytes <=
				32 * 1024 * 1024
		);
	}

	private expire(): void {
		for (const [handle, snapshot] of this.snapshots) {
			if (snapshot.expires <= this.now()) {
				this.snapshots.delete(handle);
			}
		}
	}

	protected override disposeCore(): void {
		this.connectionClosed();
		super.disposeCore();
	}
}
