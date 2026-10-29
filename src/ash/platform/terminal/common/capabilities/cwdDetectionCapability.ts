import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { TerminalCapability, type ICwdDetectionCapability } from './capabilities.js';

/** The renderer's committed directory model. Its producer decides when output and trust are committed. */
export class CwdDetectionCapability extends Disposable implements ICwdDetectionCapability {
	readonly type = TerminalCapability.CwdDetection;
	private readonly changed = this._register(new Emitter<string>());
	readonly onDidChangeCwd = this.changed.event;
	private current = '';
	private trusted = false;
	private readonly visited = new Set<string>();

	get cwds(): string[] {
		return [...this.visited];
	}
	get isTrusted(): boolean {
		return this.trusted;
	}
	getCwd(): string {
		return this.current;
	}

	updateCwd(cwd: string, isTrusted = false): void {
		if (this.isDisposed) return;
		this.trusted = isTrusted;
		if (cwd === this.current) return;
		this.current = cwd;
		this.visited.add(cwd);
		this.changed.fire(cwd);
	}

	protected override disposeCore(): void {
		this.visited.clear();
		super.disposeCore();
	}
}
