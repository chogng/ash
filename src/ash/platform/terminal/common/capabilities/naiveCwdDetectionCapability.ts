import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ITerminalChildProcess } from '../terminal.js';
import { TerminalCapability, type INaiveCwdDetectionCapability } from './capabilities.js';

/** Queries the execution owner when shell integration has not reported a directory. */
export class NaiveCwdDetectionCapability extends Disposable implements INaiveCwdDetectionCapability {
	readonly type = TerminalCapability.NaiveCwdDetection;
	private readonly changed = this._register(new Emitter<string>());
	readonly onDidChangeCwd = this.changed.event;
	private last: string | undefined;
	private generation = 0;

	constructor(private readonly process: ITerminalChildProcess) {
		super();
		if (!process.getCwd) throw new TypeError('A cwd detection capability requires a process directory query');
	}

	async getCwd(): Promise<string> {
		this.assertNotDisposed();
		const generation = ++this.generation;
		const cwd = await this.process.getCwd!();
		if (this.isDisposed) throw new CancellationError();
		if (generation === this.generation && cwd !== this.last) {
			this.last = cwd;
			this.changed.fire(cwd);
		}
		return cwd;
	}
}
