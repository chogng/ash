# Onboarding and feature examples

Workbench features register first-run guides through `registerOnboardingScenario` and release-note examples through `registerOnboardingTryout`. The feature that owns a control also registers its target with `registerOnboardingTargetProvider`; a provider returns its own connected element. A target used by more than one visible instance needs a run scope, and an unscoped ambiguous target is unavailable.

Guides appear after the Workbench restores, only when `onboarding.enabled` is true and the scenario is eligible. Completing or dismissing a guide records it in profile storage. `workbench.action.onboarding.resetShownState` clears that record. A feature can start a guide explicitly through `IOnboardingScenarioService.run`.

The versioned Markdown files in `app-ts/release-notes/` may link to a registered example with `[Try it](ash://tryout/<id>)`. The release notes renderer makes only registered IDs clickable. Markdown never supplies a command or its arguments; the installed `IOnboardingTryout` owns them and rechecks availability before execution. In-product clicks run the example directly. Callers of `IOnboardingTryoutService.openLink` must pass the ID-only link and receive a confirmation prompt before execution.

Use a command example when the existing command is useful and safe to open, `openView` for a view, and `guided` for a feature-owned spotlight sequence. Preparation must honor cancellation and return an exact target scope when several controls can be visible. Setup actions are offered for the user to choose; rendering a release note never runs them.

Verify changes with focused onboarding unit tests, the browser Playwright tests in `app-ts/test/integration/browser/`, and the renderer typecheck and build.
