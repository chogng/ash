import type { IKeymapInfo } from '../../common/keymapInfo.js';

/** Registry populated by the platform-specific built-in layout modules. */
export class KeyboardLayoutContribution {
	public static readonly INSTANCE = new KeyboardLayoutContribution();
	private readonly layouts: IKeymapInfo[] = [];

	private constructor() {}

	public get layoutInfos(): readonly IKeymapInfo[] {
		return this.layouts;
	}

	public registerKeyboardLayout(layout: IKeymapInfo): void {
		this.layouts.push(layout);
	}
}
