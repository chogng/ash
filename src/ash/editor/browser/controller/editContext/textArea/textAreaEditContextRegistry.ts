import { toDisposable, type IDisposable } from "../../../../../base/common/lifecycle.js";
import { type TextAreaEditContext } from "./textAreaEditContext.js";

/** Tracks textarea edit contexts for host integrations and diagnostics. */
class TextAreaEditContextRegistryImpl {
	private readonly byId = new Map<string, TextAreaEditContext>();

	register(ownerID: string, context: TextAreaEditContext): IDisposable {
		const previous = this.byId.get(ownerID);
		if (previous && previous !== context) throw new Error(`Textarea edit-context owner '${ownerID}' is already registered`);
		this.byId.set(ownerID, context);
		return toDisposable(() => {
			if (this.byId.get(ownerID) === context) this.byId.delete(ownerID);
		});
	}

	get(ownerID: string): TextAreaEditContext | undefined {
		return this.byId.get(ownerID);
	}
}

export const TextAreaEditContextRegistry = new TextAreaEditContextRegistryImpl();
