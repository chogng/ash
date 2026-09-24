import { toDisposable, type IDisposable } from "../../../../../base/common/lifecycle.js";
import type { NativeEditContext } from "./nativeEditContext.js";

/**
 * Finds an active native edit context without making clipboard or host code
 * depend on the concrete editor view instance.
 */
class NativeEditContextRegistryImpl {
	private readonly byId = new Map<string, NativeEditContext>();

	register(ownerID: string, context: NativeEditContext): IDisposable {
		const previous = this.byId.get(ownerID);
		if (previous && previous !== context) throw new Error(`EditContext owner '${ownerID}' is already registered`);
		this.byId.set(ownerID, context);
		return toDisposable(() => {
			if (this.byId.get(ownerID) === context) this.byId.delete(ownerID);
		});
	}

	get(ownerID: string): NativeEditContext | undefined {
		return this.byId.get(ownerID);
	}
}

export const NativeEditContextRegistry = new NativeEditContextRegistryImpl();
