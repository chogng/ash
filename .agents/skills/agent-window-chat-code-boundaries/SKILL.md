---
name: agent-window-chat-code-boundaries
description: Audit and fix Chat and Code action leaks in the Ash Agent Window. Use when a control, menu item, command, or shortcut appears or runs in the wrong mode, or when reviewing shared action wiring for both modes.
---

# Audit Chat and Code action boundaries

Review both directions for a general audit. For a reported control, start with its owning surface and trace every entry point to the same action. A review request calls for findings. Apply fixes when requested.

## Determine the owner

- Trace the action to the service, object, and state it reads or changes. Classify it as Chat, Code, shared, or an explicit handoff. Use the current product behavior and the owning contract as evidence. Shared widgets, `chat.*` command IDs, and model providers can serve both modes.
- Distinguish the active workspace mode, the visible page, the focused widget, and the target record. `SessionsWorkspaceModeContext` identifies the workspace mode. `CodeConversationPageContext` identifies the Code conversation page. `SessionsCodeEditorContext` identifies the Code document-tool surface. `ChatContextKeys.replyOnlyInput` describes composer capability, and `messageActionSurface` describes transcript presentation. A Chat Thread opened through Continue in Code has the Code presentation and keeps its Chat identity.
- Preserve explicit mode switches, handoffs, deep links, and restoration through their owning routes. Check shared actions against their intended target in each mode. For example, a history picker opened in Chat should select the Chat conversation through its owner. Continue in Code should open the selected Thread in Code.

## Trace the entry points

| Surface | Inspect |
| --- | --- |
| Composer | Draft, reply, and edit variants. Check the add menu, slash commands, picker actions, send and queue actions, and shortcuts with focus in the input. |
| Transcript | User and assistant action bars, overflow and right-click menus, and actionable content cards. Verify that the action receives the clicked message and its presentation context, including when another conversation is active. |
| Session chrome | Conversation title bar, overflow, and sidebar conversation or project right-click menus. Check selected and unselected rows and compare the Chat and Code entries in `Menus`. |
| Commands and keys | Search by command ID through `registerAction2`, `CommandsRegistry`, menu contributions, default keybindings, aliases, and direct handlers. Check the command palette with focus in the composer and outside it. Check user keybindings without a `when` clause. If the feature has a Quick Access prefix, exercise it directly. |

Start with [Sessions context keys](../../../src/ash/sessions/common/contextkeys.ts), [Sessions menus](../../../src/ash/sessions/browser/menus.ts), and the feature's contribution. Search `src/ash/sessions` and the shared `src/ash/workbench` contributions loaded by the affected `sessions.*.main.ts`. Shared Workbench contributions can expose actions in the Agent Window even when Sessions registers no local entry for them.

## Match presentation and execution

- Use existing context keys at the scope that resolves the entry. The [command palette](../../../src/ash/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts) reads the window menu and also offers supported editor actions. A condition set only on the input can protect an input shortcut while leaving a palette entry visible. Use row or widget context for actions that need a specific target.
- [Action registration](../../../src/ash/platform/actions/common/actions.ts) uses `precondition` for `f1` entries and combines it with built-in keybinding conditions. The registered command calls `run` directly. Where a mode-specific command can be invoked by ID, guard execution at the action or feature owner too. For instance, hide Code's terminal launcher in Chat and verify that binding its ID to a custom key in Chat still leaves terminal state untouched.
- Resolve the visible widget or the explicit target before acting. Recheck mode and target after a picker or other asynchronous step when a stale result could act on a retained conversation or switch the window back. Reuse the owner's navigation revision, visibility, or cancellation checks where they fit.
- Keep Sessions policy at the composition boundary. When a Workbench action is shared with the IDE, preserve IDE behavior through an existing capability contract and verify the IDE path if the fix touches it.

## Verify and report

- For each changed action, check that it appears and works in its owning mode, and that the other mode neither exposes it nor executes it through an affected command or shortcut. Assert the actual result, such as the selected Thread, unchanged draft, terminal count, or active workspace mode. Include a mode switch with the original conversation retained when retained state is relevant.
- Use focused fixtures for owner routing and stale targets. Use the existing [Sessions navigation smoke test](../../../test/smoke/areas/sessions/sessions-navigation.spec.ts) for window-level palette and keyboard wiring, including a custom key exercised in both modes. Use the [smoke test workflow](../smoke-tests/SKILL.md) when the behavior depends on the Desktop host or its keybinding dispatch.
- Report confirmed leaks by surface and direction, how they were triggered, and what the fix and regression checks covered. Identify any entry point or host left unverified.
