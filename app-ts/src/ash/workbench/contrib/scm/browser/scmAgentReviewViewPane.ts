import { Button } from "../../../../base/browser/ui/button/button.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import type { IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ViewPane } from "../../../browser/parts/views/viewPane.js";
import { h } from "../../../../base/browser/dom.js";

/** Projection point for review findings produced by an agent session. */
export class ScmAgentReviewViewPane extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.contentElement.classList.add("ash-scm-secondary-pane");
		const empty = h(container.ownerDocument, "p");
		empty.className = "ash-scm-empty";
		empty.textContent = "No agent changes to review.";
		const findIssues = this._register(new Button(this.contentElement, {
			label: "Find Issues",
			icon: lxiconsLibrary.codeReview,
			contentAlignment: "labelCentered",
			title: "Find Issues",
		}));
		findIssues.toggleClassName("ash-scm-find-issues", true);
		this.contentElement.append(empty, findIssues.domNode);
	}
}
