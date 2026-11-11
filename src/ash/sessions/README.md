# Code Sessions

`sessions/` owns Ash Code's dedicated agent Workbench beside the regular
`workbench/`. Its product and build boundary is canonical in
[`docs/workbench.md`](../../../docs/workbench.md); this README
is canonical for the renderer implementation and extension points.

UI design and style boundaries are defined in [Sessions style](STYLE.md).

[`sessions.desktop.main.ts`](sessions.desktop.main.ts) wires the
[`chatgptweb` adapter](contrib/chatgptweb/README.md) into the
[desktop Chat contribution](contrib/chat/electron-browser/chatWorkspace.contribution.ts).
The shared Chat workspace consumes catalog and editor contracts. Only the
desktop entry point imports the adapter from outside its contribution in Sessions.
The window bootstrap lives in `sessions/electron-browser` in the
[Sessions core](LAYERS.md#sessions--sessions-core).

The `contrib/chatgptweb` adapter handles ChatGPT authentication and transport
integration. It owns conversation and project identities, history, messages,
drafts, model presets and streamed replies. It reports when a conversation
identity is retired or replaced so the host can maintain its own preferences.

The desktop host presents those records in Ash's [Sessions view](contrib/sessions/browser/views/sessionsView.ts), Projects,
search and `ReplyChatEditor`. The desktop Chat list model combines catalog
records and supplies ordered sections and row operations. The view owns
rendering, keyboard focus and scrolling. The adapter maps ChatGPT identities, messages and actions to the
host's contracts. The [catalog project ownership contract](SESSIONS_LIST.md#catalog-project-ownership)
defines which actions reach a provider.
Ash Chat owns entity details, including the auxiliary pane, its controls and the
local cache of completed replies and their fetched resources. Cache identities
include the backend, verified account, conversation, reply, language and entity.
The ChatGPT Web response backend supplies the stream and resources, and the
shared Chat renderer presents galleries with previous and next actions.
The Workbench message editor shares editing and resubmission between Ash Chat
and Code. App Server owns their Thread rewrites. The ChatGPT adapter supplies
the same editor with remote message capabilities and uses the web backend to
confirm edits and switch versions within the existing remote conversation.
In an eligible new Chat draft, selecting an Ash model asks the
adapter for the current unsent text after model validation. The host opens an
independent Ash Chat draft without sending a message. Its first send creates a
Chat-owned Thread through the shared App Server.
The `ash-chatgpt` editor resource and conversation storage keys stay stable
across entry restoration. Previous native-experiment restore commands resolve
to this same entry without creating or sending a new conversation.

The selected model source determines where a message is sent. ChatGPT Web
sends through its reply backend. Older ChatGPT conversations may contain
references to linked Ash tasks. The adapter reads their existing status and can bind
a legacy local conversation to a ChatGPT history without losing those references.
The profile keeps the last loaded sidebar index, last confirmed project
instructions, and opened conversation snapshots under an opaque user and
workspace scope verified by the native credential owner. Chat shows that cache
while refreshing from the backend and requires a current history read before
continuing a restored conversation. Cached project instructions can be displayed
immediately. Edit access requires a live project details read. The sidebar refreshes on focus,
network recovery and a foreground interval. Refresh checks the loaded portion
of the catalog and verifies omitted conversations individually before removing
their snapshots. An account-scoped outbox persists offline first text messages
and deletions. Ash records a creation's stable message ID before submitting it
and checks cloud history if the result is ambiguous. A deletion stays hidden
locally while it retries and after acknowledgement. The linked Ash Thread owns
execution, approvals and artifact bytes.
Chat reopens that Thread by reference and does not duplicate the task journal.

The profile-scoped Rust ChatGPT Web authentication owner supplies request-bound
authorization over the daemon's native-only credentials connection. The New context
menu offers independent Ash device sign-in, explicit read-only Codex reuse and sign-out.
Independent credentials and source selection share one guarded profile SecretStore
record. The owner renews these tokens before use, persists rotation before granting
headers and handles same-account 401 recovery once. External Codex credentials remain
read-only; a failure never switches the selected source. Each window's account login
adapter retains its own completion route while sharing the profile owner. Main no longer reads
`auth.json`; credential headers never cross renderer RPC or the HTTP result channel.
The renderer carries an opaque request context and cache scope. Account changes or owner
connection loss revoke pending requests and retire Chromium cookies; the ChatGPT
model drops the old account's history, conversation IDs and attachments while
preserving local unsent draft text. A definite HTTP 401 may be retried once after
the owner supplies a replacement authorization, before any response is delivered.
The window-owned Main transport executes those requests. Its hidden Chromium
runtime only performs the website's request verification. It does not host an
additional chat UI or own conversation state. Voice capture and playback use
the renderer's existing media lifecycle. ChatGPT remains separate from the
Agent/Codex model service, local Threads and execution lifecycle.

Shared Agent execution, Thread records, approval metadata and profile execution
defaults belong to `platform/agentHost/common/`; model catalogs belong to
`platform/models/common/`. Each domain's browser adapters own App Server DTO
conversion; Workbench and Sessions consume the shared domain contracts. The
Sessions provider owns the mapping into `ISession` and `IChat`, while
`languageModels` owns model picker state for both windows.

Regular Code Chat requests 20-Turn `latest` windows for read and subscribe.
`ChatWidgetModel` retains explicitly loaded pages and uses `before` cursors to
load earlier messages. Tail refreshes preserve that prefix; reconnect fills any
missing windows before joining it. Historical reads do not advance the live
transcript revision or overwrite execution state. Interaction offers retain their
connection owner independently of visible history. `ChatWidget` owns pagination,
focus and reading-position presentation. Consumers that omit the history option,
including native Chat, retain full-history behavior.

Workbench `ChatViewPane` owns the Chat frame, active-widget projection, opened-tab
order and close behavior, session-list layout, composer entrypoints and editor
mount. The Workbench also owns layout actions, configuration and menus.
Sessions `SessionChatViewPane` supplies retained conversation models, selection
revision, draft persistence and auxiliary-window composition. `ChatHistoryModel`
projects one window catalog through `IAgentSessionsService.model`; the list reads
Session roots and history reads their child Threads. Both reopen captured resources
through `getSession`, while the original Session owner retains all mutable state.
Actions use
`IChatViewPane` and `IChatSessionNavigationService` without importing Sessions
implementations. IDE history commands and `AgentSessionsPicker` belong to Workbench;
Session-backed history enters through `IAgentSessionsService`; shared archive, restore, rename, delete and Changes commands use `IAgentSessionActionsService`. Workbench owns their prompts and editor presentation; Sessions owns target resolution, draft materialization and mutations.
The Sessions adapter owns no picker DOM, focus, popup lifetime, or additional catalog.

`contrib/chat/browser/chatView.ts` owns the retained Code `NewChatView`, its
provider scope, model binding and information rail. It creates `NewChatWidget`,
which specializes the shared `ChatWidget` and owns its `ChatInputPart`,
session toolbar, Tip above the input and footer project picker in Code. The view and
input survive draft materialization; the existing model remains the only owner
of the Session identity and first-send operation. `SharedChatInputComposer` supplies
editor and draft policy to the shared input. File selection, paste,
drop, attachment preparation and cancellation belong to the shared Workbench input.
The shared composer presents local staging and gates Send on attachment readiness.
Backends that upload ahead of Send own transfer, retries and remote confirmation.
Its permission slot binds the current model to Workbench `PermissionPickerActionItem`, which owns
the shared permission menu, keyboard interaction and popup lifetime.

In local Code, the Project is the unit of organization for conversations. A
Project can contain several folders and needs at least one usable folder to
start a conversation. **Choose project** lists saved Projects. Selecting a
Project with one folder uses that folder directly. With several folders, choose
the working folder from the Project's submenu. Selecting a Project that has no
folders yet prompts for its first folder. **Open Folder** selects the Project
that already contains the directory or creates a Project for it.

The draft keeps the Project ID for conversation membership and the selected
workspace for execution. Sessions management links the durable conversation to
the Project through `IProjectService` before the first request can run. Worktrees
and Dev Containers change where the Agent runs while retaining the selected
Project. The picker owns folder history, cancellation and focus restoration.
For an independent remote Agent host, folder selection stays on that host.
The Workbench Welcome workspace picker has a separate delegate and presentation;
it does not own the Sessions execution environment.

The shared `chatInputStatePersistence` codec separates input state from attachment
snapshots. Sessions `newChatDraftState` retains workspace-scoped keys, complete
draft validation and migration. Each input record references an immutable attachment
payload; text or mode edits reuse it. Publishing state follows payload creation,
and replacement or removal releases the old payload. Combined drafts migrate on
read after validation; conflicting legacy migrations preserve both records.

Shared notices, introductions and tips live under
`workbench/contrib/chat/browser/widget/input/`.
`ChatInputPart` owns one `ChatInputNoticeHost` per composer. Input errors,
feature introductions and tips claim that host in descending priority; model errors
remain model-owned. `ChatInputOnboarding` owns introduction host selection, deferred
creation and persistence. Dictation owns its card and microphone trial,
which stops when the card loses its place. Visible composers register with the
window's notice hub; hiding a composer releases its introduction and focus registration.
`ChatInputNotificationService` owns window-local notification ordering and dismissal,
with composer identities preventing messages in one input from hiding another's notices.
`ChatInputNotificationWidget` owns banner rendering and action lifetimes. Input state
only projects failures into the service; replacing a conversation or disposing its
composer retires those projections. The composer registers voice onboarding in its
notice lane while the input is visible.
Voice introductions retain the profile acknowledgement preference and share one
service across Chat, Code and floating voice controls. Escape and hiding an input
release their presentation without acknowledging it; Got it records acknowledgement.

Workbench `AgentSessionsWelcomePage` and Quick Chat borrow independent retained
conversations through `IChatViewPane.createEmbeddedChat`. `SessionChatViewPane`
retains each model, draft and widget while its host owns placement and visibility.
Releasing a host removes its workspace delegate and submission route before the
same widget returns to Chat. Welcome in an empty window owns the trusted recent
workspace selection; its `IWorkspacePickerDelegate` passes through `ChatWidget`
and `ChatInputPart` to the Workbench `WorkspacePickerActionItem`. A target submission
opens a new workspace window with a validated, expiring draft handoff addressed to
that workspace. The target prefills text, mode and captured context without sending.
A failed open restores the source draft and cannot fall through to local execution.

Quick Chat borrows a distinct retained conversation from `SessionChatViewPane`.
Its background draft leaves foreground selection unchanged; hiding the overlay
retains the composer and live response. Opening in Chat View reparents that same
widget and selects its existing identity without replaying messages.

Regular Workbench Chat presents opened Sessions through the shared Workbench tab
control by default, with a List alternative in Chat More Actions. The host owns
opened-tab order; the Sessions adapter persists it alongside per-session Thread
selection in `chat.viewState` version 2. Session and execution state remain with
the existing services. Closing a tab
captures its draft and releases its view without archiving or interrupting the
Session. The Chat title projects into AuxiliaryBarPart's single header, which
suppresses redundant container navigation when Chat is its only visible container.

Web embedders load `sessions.web.main.internal.ts` after initializing localization,
then call `create(container, profile)` and retain its disposable handle. The Web
entry loads shared and browser contributions; `browser/web.factory.ts` owns the
embedding lifetime and `browser/web.main.ts` owns browser services and the
Sessions Workbench. Disposing during startup shuts down the instance once it
finishes opening. The Vite host generates the Code product page at
`/browser/sessions/sessions.html`; no Sessions page bootstrap lives under
`code/browser/sessions`.

Creator's Sites mode, contribution boundaries, implementation order and acceptance
requirements are described in [Creator Sites](CREATOR_SITES.md).

Code's composer shows manually attached pull requests alongside those associated
with Git branches in the selected Session's execution directory.
`contrib/github/browser/githubService.ts` consumes
the frontend Git and GitHub services and owns this derived state; it does not change
the canonical Session snapshot. `contrib/chat/browser/sessionChatInputToolbar.ts`
and the sidebar consume the same result. The sidebar selects the highest-priority
icon across repositories; accessible names retain all attention reasons. Branch
changes remove automatic associations but retain manual attachments; ordinary PR
updates preserve link focus.
Account changes cancel reads and clear private data.

In an existing Code conversation, Add context (+) → Pull Request accepts a
GitHub.com or Enterprise URL and verifies access before saving its host, repository
and number. App Server stores these references
on the Session's root Thread in the profile SQLite database, through
`github/session/pullRequests`, `github/session/pullRequest/attach` and
`github/session/pullRequest/detach`. Changes notify subscribed windows through
`session/changed`. Titles, status and account credentials are never persisted with
the reference. Reopening a Session restores attachments, including Sessions without
a workspace; unreadable PRs retain an explicit unavailable status and a Remove
action. Remove detaches the saved reference without closing the PR or removing an
association still supplied by the current branch. Session deletion clears its
references, and history transfer carries them with the root Thread.

In Code’s composer, Attach issue verifies a GitHub.com or Enterprise Issue URL before saving its
identity through `github/session/issue/attach`. The input toolbar reads
`github/session/issues`, shows open, closed and unavailable counts, and expands
into links with complete status labels and individual Remove actions. Issue reads
refresh independently of PR discovery. Any open or unresolved Issue keeps the
summary active; collections of closed Issues distinguish completed from entirely
discarded results. Account changes cancel reads and clear private titles; saved
identities remain removable without a connected account. Removal uses
`github/session/issue/detach` and does not close the Issue. These references share
the root Thread's deletion, restoration, history-transfer and cross-window
notification rules, while live titles and status remain in the Sessions service.

Code's Changes view continues to read immutable Turn changes from ChatService.
`contrib/changes/common/sessionChangesService.ts` owns the contract for opening
a Changes editor; its browser implementation resolves captures through ChatService
and supplies reconstructable tab counts. Saved Changes inputs retain the selected
capture ID alongside their Session and Thread identity. The shared Multi Diff
keeps the containing editor's menu identity and applies file reveal options through
its existing collapse and scroll state. Capture operations bind file paths and
expected revision before preparing a commit preview.
Its summary reflects the visible file changes; failed loads clear stale selections
and offer Retry. Review working tree opens the optional Git provider’s live diff.
Session information hosts repository status, branch actions and PR Checks under
Environment. The Git action service resolves the selected conversation’s
directory and passes the repository identity to the Git extension. Sync checks
the branch and remote again between pull and push. Checks owns cancellable,
paginated CI reads through the GitHub API. Account and Session changes invalidate
old data, and hiding the rail releases its model.

ChangesViewService owns presentation state. The profile's UI state stores List or
Tree mode; window-local snapshots retain selection, focus, expanded folders and
scroll positions independently for each conversation, selected Turn and mode.
Checks collapse state follows the conversation. Read markers belong to the exact
Turn revision and remain window-local; they neither change the ledger nor grant
commit eligibility. Repository tracking and working-tree counts come from the
optional Git provider, independently of the immutable Turn list.

The Code tool layout retains Terminal, Files, Changes, Browser and session
information in one movable Grid. DesktopWorkbenchLayout owns its geometry;
DesktopLayoutController supplies the selected Session identity without owning
another layout map. Each Session remembers its tool arrangement, while navigation
and tool visibility remain window-owned. Browser has its own retained editor host,
and BrowserView continues to own page models and native Chromium content. Closing
a tool hides its presentation without closing its documents, terminal or pages.
See [Code tool composition](LAYOUT.md#editor-presentation) for host boundaries and
[layout state](LAYOUT_CONTROLLER.md#6-persistence) for persistence.

In Session information, Environment offers Create pull request for the current
Code conversation. It opens an editable form. Submission checks the captured repository, local commit, remote and
account again. Once sent, completion belongs to the initiating Session even when
the form closes; the resulting reference is attached through the existing GitHub
API. An uncertain response prevents repeating submission in the same form.
Attachment and auto-merge failures remain warnings on the created PR, and a
published head different from the local commit prevents automatic merging.

The profile remembers only draft, allowed merge method and the last form action,
never titles, descriptions, repository paths or credentials. Ask agent to create
submits the displayed values and captured repository context through ChatService
to the initiating Thread; an active Turn queues the request. Preparation rechecks
the same context as direct creation. Agent submission uses the ordinary permission
path and conservatively disables retries after an unconfirmed write. A submitted
agent request is an acknowledgement, not a created PR or a background merge policy.

Discovery and periodic refresh follow the selected Session. Other Sessions retain
their last result for the current window and refresh when selected again; Sessions
that have not been selected have no resolved association yet. PR artifacts produced
by agents are not automatically recorded by this service.

Automations load through `sessions.common.main.ts` in Web and Electron.
`contrib/automations/browser/automations.contribution.ts` registers the provider
aggregate, editing-dialog service and manual-run coordinator. The UI contribution
in `contrib/sessions/browser/views/automationsView.ts` is registered by
`sessions.contribution.ts` at `BlockRestore`. The Activity Bar navigation
invokes `sessionsView.manageAutomations` to open its independent Custom View;
creation and editing use a modal dialog that retains the reviewed revision.
Startup restores the covered entry and session without closing the Custom View
or stealing focus. Explicit navigation closes it; Back and Forward visit both.
The provider registry borrows the window's existing App Server Sessions provider.
Its automation store owns observable frontend snapshots. Product contracts live in
`workbench/contrib/chat/common/automations`; `platform/automations/common/automation.ts`
and `platform/automations/browser/appServerAutomationService.ts` own the host contract
and App Server adapter. Rust owns persistence,
scheduling and execution. Closing a view or window does not stop its runs.
See [Automation ownership and lifecycle](../../../crates/docs/automation.md).

## Ownership

| Area                                  | Owner                                                                                                                                                                                          | Current implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window host                           | `browser/web.main.ts`, `electron-browser/sessions.ts`, `sessions.desktop.main.ts`, and `electron-browser/sessions.main.ts`                                                                     | start the browser or Electron Sessions renderer and register desktop actions                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Desktop window host                   | `platform/windows/electron-main/windowImpl.ts` and `windowsMainService.ts`                                                                                                                     | the first owns each Electron window and its resources; the second owns live Workbench and Sessions windows plus pending handoffs and acknowledgments, rejecting them on reload, crash or close; `code/electron-main/app.ts` supplies Sessions workspace context and connections                                                                                                                                                                                                                                                   |
| Main-process close                    | `platform/lifecycle/electron-main/lifecycleMainService.ts`                                                                                                                                     | waits for either renderer to finish shutdown before closing its window                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Workbench window selection            | `platform/windows/electron-main/windowsFinder.ts` and `platform/windows/electron-main/windowsMainService.ts`                                                                                   | match folder or workspace files to live windows, reuse a matching Workbench, and keep active-window order; Sessions owns the return action and its IPC contract                                                                                                                                                                                                                                                                                                                                                                   |
| Browser window navigation             | `code/browser/workbench/workbench.ts` and `sessions/browser/web.main.ts`                                                                                                                       | navigate to their sibling renderer page; the Sessions profile validates its return path                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Browser renderer lifecycle            | `workbench/services/lifecycle/browser/lifecycleService.ts`                                                                                                                                     | joins shutdown work when the browser page closes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Electron renderer close               | `workbench/services/lifecycle/electron-browser/lifecycleService.ts`                                                                                                                            | checks shutdown vetoes and joins save work before either Electron window closes                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Code profile                          | `code/common/codeSessionsProfile.ts`                                                                                                                                                           | defines the Code window identity and page route used by both browser and Electron entries                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Product composition                   | `browser/workbench.ts`                                                                                                                                                                         | uses shared window identity and lifecycle services and creates retained Parts; the concrete layout owns their topology and geometry                                                                                                                                                                                                                                                                                                                                                                                               |
| Workbench construction                | `browser/workbenchFactory.ts` and `browser/desktopWorkbench.ts`                                                                                                                                | prepares window resources and creates the desktop Workbench; the abstract Workbench owns shared services and Parts                                                                                                                                                                                                                                                                                                                                                                                                                |
| Code Files and Changes                | `contrib/files/browser/`, `contrib/changes/browser/`, and `common/views.ts`                                                                                                                    | register only in the Sessions view catalog; Files reuses Explorer, Changes reads the selected conversation's Turn ledger, and both open the shared Workbench Editor Part. Changes identities live in contrib/changes/common/changes.ts; its accessibility module supplies live view/editor content, while the contribution owns registration                                                                                                                                                                                      |
| Code editor commands                  | `contrib/editor/browser/editor.contribution.ts` and `addTabActions.ts`                                                                                                                         | own window-scoped command/menu registrations and context keys derived from layout state; `SessionsEntryService` creates and releases the contribution, while layout operations remain queued through the existing controller                                                                                                                                                                                                                                                                                                      |
| Session file access                   | `services/workspace/browser/workspaceContextService.ts` and `contrib/providers/agentHost/browser/sessionFileService.ts`                                                                        | Explorer follows the selected Session directory; resource identities retain previously opened directories, while the transport adapter selects the Session directory protocol                                                                                                                                                                                                                                                                                                                                                     |
| Layout                                | `browser/desktopWorkbench.ts`, `browser/layoutPolicy.ts`, `services/layout/common/sessionsEntryService.ts`, and `contrib/layout/browser/`                                                      | DesktopWorkbenchLayout owns topology, geometry and persisted Part sizes/visibility; the layout policy supplies initial sizes and frame metrics. The Sessions entry service applies feature-owned entry descriptors. Code presents Files as one Grid card containing its Explorer and shared EditorPart document tabs; Terminal is another independently arranged card. The base controller restores session editors and panel views; the desktop controller owns explicit document/tool visibility and managed Files/Changes tabs |
| Appearance                            | `common/configuration.ts` and `contrib/modernUI/browser/`                                                                                                                                      | own the independent Sessions layout, Activity Bar position, and size preferences                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Accounts and settings                 | `contrib/accounts/browser/` and `contrib/preferences/browser/`                                                                                                                                 | the account icon opens a Sessions-owned menu with Settings and Return to Workbench; Settings opens a Sessions-owned page that reuses the Workbench setting widgets                                                                                                                                                                                                                                                                                                                                                                |
| Window Sessions state                 | `services/sessions/browser/sessionsService.ts`                                                                                                                                                 | owns one active/visible selection model and Back/Forward history for the window                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Frontend Session model                | `services/sessions/common/session.ts`                                                                                                                                                          | owns `ISession`, `IChat`, workspace summary, and untitled identity types                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Shared Chat contract                  | `workbench/services/chat/common/chatService.ts`                                                                                                                                                | owns Thread and Turn operations plus shared Session/Thread IDs, model references, and approval modes used by both renderers                                                                                                                                                                                                                                                                                                                                                                                                       |
| Provider and management               | `contrib/providers/agentHost/browser/workbenchSessionsService.contribution.ts`, `services/sessions/common/sessionsManagement.ts`, and `services/sessions/browser/sessionsManagementService.ts` | the App Server provider adapts transport data; management owns catalog, drafts, and operations; the contribution registers and starts it in the regular Workbench                                                                                                                                                                                                                                                                                                                                                                 |
| Regular Workbench Chat                | `browser/workbenchChat.contribution.ts`, `browser/chatViewPane.ts`, and `browser/chatWidgetModel.ts`                                                                                           | registers the Session-backed Chat view and navigation/history adapters; Workbench `contrib/chat/browser/actions/chatNewActions.ts` owns New Chat and calls the adapter to create its draft; both list hosts share item commands and profile pin/group state; one model owns draft materialization and Thread subscriptions for each shared `ChatWidget`                                                                                                                                                                           |
| Main conversation                     | `browser/parts/sessionsPart.ts`, `sessionView.ts`, and `sessionGridLayout.ts`                                                                                                                  | one shared conversation grid with a retained SessionView per slot; Chat/Code switch only the renderer inside each view                                                                                                                                                                                                                                                                                                                                                                                                            |
| Code composer                         | `contrib/chat/browser/sharedChatInputComposer.ts` and `media/chatInput.css`                                                                                                                    | retain the existing Code welcome input, attachments and permission menu                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Native Chat                           | `contrib/chat/browser/nativeChatPaneFactory.ts`, `ashChatModel.ts` and `replyChatInput.ts`                                                                                                     | compose Chat and Collaboration layouts and model preferences over the native Chat model, shared transcript renderer, input operations and draft binding                                                                                                                                                                                                                                                                                                                                                                           |
| Composer persistence                  | `contrib/chat/common/newChatDraftState.ts`                                                                                                                                                     | owns workspace-scoped drafts keyed by untitled identity or Thread; migrates older Chat/Code keys without discarding conflicting drafts                                                                                                                                                                                                                                                                                                                                                                                            |
| Welcome tips                          | Workbench `chatTipService.ts` and `widget/input/chatInputTipPresenter.ts`                                                                                                                      | shared tip catalog, presenter and profile dismissal; Chat limits eligibility to attachment tips                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Turn review                           | `browser/turnMultiDiffSource.ts`, Workbench `contrib/chat/browser/chatEditing/chatEditingActions.ts`, and `contrib/changes/browser/changesMultiDiffSourceResolver.ts`                          | compose Turn changes and register their source resolver and commit action with `workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.ts`                                                                                                                                                                                                                                                                                                                                                                      |
| Parts                                 | `browser/parts/`                                                                                                                                                                               | hosts the shared Part modules and their owned media; navigation components remain in `sidebar/`, and product-specific Activity Bar components remain in `activitybar/`                                                                                                                                                                                                                                                                                                                                                            |
| Activity Bar                          | `browser/parts/activitybar/`                                                                                                                                                                   | renders menu commands, persists their order, and owns account entry, DOM, and presentation; uses shared controls, configuration, and menu services as a disposable navigation component, without registering a window Part or importing Workbench Activity Bar styles                                                                                                                                                                                                                                                             |
| View containers                       | `workbench/services/panecomposite/browser/panecomposite.ts` and `workbench/browser/parts/paneCompositePartService.ts`                                                                          | both windows use the same service to open, hide and focus containers; Parts retain their instances                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Projects and Creator                  | `contrib/projects/browser/projects.contribution.ts` and `contrib/artifacts/browser/artifacts.contribution.ts`                                                                                  | contribute Activity Bar commands and retained EditorPanes; Projects keeps catalog browsing and details inside its EditorPane, with window-local state in `projectsService.ts`; the Project domain owns durable project metadata and material references                                                                                                                                                                                                                                                                           |
| Creator                               | [`contrib/artifacts/`](contrib/artifacts/README.md)                                                                                                                                            | owns seven independently registered creation workspaces and their shared canvas document, editing and file lifecycle; loads through `sessions.common.main.ts`. Sessions Settings exposes its profile-scoped cursor and accessibility preferences in Design.                                                                                                                                                                                                                                                                       |
| Application menu and titlebar actions | `browser/menus.ts`, `browser/parts/menubar.contribution.ts`, and `browser/layoutActions.ts`                                                                                                    | Sessions owns its menu root, File menu, and layout action menu; common sections are explicitly shared. The Workbench BrowserMenubarControl owns menu interaction; the layout and Sessions service own sidebar visibility and history                                                                                                                                                                                                                                                                                              |
| Regular Workbench Chat history        | Workbench `contrib/chat/browser/actions/chatActions.ts`, `contrib/chat/browser/agentSessions/agentSessionsPicker.ts`, and Sessions `browser/chatHistoryModel.ts`                               | Workbench owns the IDE command, picker UI, focus, menus and popup lifetime; the Sessions adapter implements the Workbench presentation contract by projecting existing Session and pin state and invoking existing operations                                                                                                                                                                                                                                                                                                     |
| Session chat commands                 | `browser/actions/sessionsChatActions.ts` and `contrib/sessions/browser/sessionsActions.ts`                                                                                                     | The chat action module owns composer commands. The Sessions action module owns session navigation and the history picker entry.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Open Agents Window                    | `code/browser/workbench/workbench.ts`, `workbench/contrib/chat/electron-browser/`, `contrib/openAgentsWindow/electron-browser/`, and `workbench/browser/parts/titlebar/`                       | the browser product entry owns page navigation; the Chat desktop contribution owns the titlebar action, hover label, and window command; the Sessions desktop contribution owns system-wide shortcut synchronization; the Workbench titlebar owns the shared mark and motion. Shared shortcut selection lives in `workbench/contrib/keybindings/`, while `platform/globalKeybindings/` owns operating-system registrations                                                                                                        |

Desktop invitation activity and its single cross-window claim belong to Main's
`platform/chat/common/agentsWindowInvitation.ts` state, assembled in
`code/electron-main/app.ts`. Only accepted renderer requests establish the originating
window document; catalog broadcasts do not. Window reload, crash and close retire that
activity. Desktop storage owns usage and impression persistence, while Rust continues
to own Session, Thread and execution state. The Workbench contribution reuses notification
Parts and the existing window handoff acknowledgment before clearing an unsent draft.

The [shared Parts contract](LAYOUT.md#shared-parts-and-mode-content) provides shared editor and optional sidebar/view-container hosts for desktop pages. [Activity Bar entry switching](LAYOUT.md#activity-bar-entry-switching) activates a sidebar ViewContainer and coordinates the central editor page and right-hand container through feature-owned entry commands. SessionsPart remains the conversation host; Projects and Creator use retained EditorPanes. The boundary between shared window assembly, concrete layout families and page compositions is defined in [Layout implementation boundary](LAYOUT.md#layout-implementation-boundary). The phone implementation remains planned.

The shared Session pane uses the Workbench Chat renderer for Code and
[native Chat](contrib/chat/browser/nativeChatPaneFactory.ts). The Chat contribution
owns its model preferences, welcome layout and picker placement. The compact Ash Chat
editor and Session pane read the same `sessions.chat.defaultModel` setting and
remembered model. The native model and Workbench draft binding handle conversation
state and persistence.
The shared Workbench model picker owns both model and configuration triggers,
menus, keyboard focus and disposal. Effort and context size use the same
configuration menu; Sessions retains its composer styling.

`ISessionsService` owns one active selection, visible arrangement and Back/Forward
history. `SessionsPart` owns one `SessionGridLayout` and one retained `SessionView`
per visible Session. Each view hosts the Code or native Chat presentation through pane
factories, retaining its model instances, composer DOM and pending submissions. Switching
entries transfers unsent text, mode and resolved attachments into the active
renderer and clears the inactive composer; the grid and SessionView stay attached.
Code reveals editor tools; Agent Teams
selects the Teams sidebar. Creator aggregates independently contributed creation tools in its navigation container and retains their workspaces. The Projects EditorPane shows project cards and opens their conversations and any project details and materials. The Chat sidebar shows Pinned and Recent. Creator uses the shared EditorPane and side View hosts. The Sessions entry service accepts entry descriptors from the owning contributions; `DesktopLayoutController` remains responsible for session documents and Editor/Details behavior.
See [input and conversation state ownership](../../../docs/input-state-ownership.md)
for the boundary with regular Workbench Chat and SCM.

Each contribution's `ChatAttachmentModel` owns its composer's attachment collection.
Sessions file acquisition resolves UTF-8 text or supported image data before
adding it. `ChatService` converts resolved images to image input items and omits
empty text when sending attachments alone. Approval choice remains in the Chat
model and is applied to a new Turn through the existing backend contract.
Changing it does not change the approval mode of a running Turn. New Code and
Chat composers inherit the connected profile's execution approval default until
a conversation choice overrides it. Settings → Execution and permissions keeps
only unsaved drafts in Sessions. App Server owns `[agent.execution]` persistence
and command sandbox reload; the existing trusted host directory permission API
owns grants and revocation. Ordinary chats and built-in Symphony share these
defaults. Saving applies to future Turns and newly prepared commands after reload,
without terminating running processes; managed network rules remain enforced.

Unsent composer content is window/workspace UI state. Each untitled identity and
Thread has its own `sessions.inputDraft` entry. All untitled identities and the
visible arrangement are restored from `sessions.viewState`; navigation history
starts from the restored selection. Legacy Chat/Code arrangements are merged,
and conflicting drafts become separate untitled Sessions. Renderer shutdown
joins pending attachment resolution before flushing storage.

### Input ownership and names

Agent Window has three product input components; IDE Chat is a fourth host. They
all use `workbench/contrib/chat/browser/widget/input/chatInputEditor.ts`, backed by
`editor/browser/widget/codeEditor/codeEditorWidget.ts`. IDE, Code and native Chat also
use `chatInputPart.ts` for input operations; ChatGPT owns its service-specific
controls. Each product owns its composition, model policy and draft lifecycle.

| Host              | Ash component and owner                                                                                   | VS Code relationship                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Window Code | `SharedChatInputComposer` in `contrib/chat/browser/sharedChatInputComposer.ts`                            | Composes Sessions input policy for new and existing Code conversations around Workbench `ChatInputPart`.                                       |
| Native Ash Chat   | `ReplyChatInputFactory` in `contrib/chat/browser/replyChatInput.ts`                                       | Composes the shared input and draft binding for the Session pane.                                                                              |
| ChatGPT in Chat   | Shared `ChatWidget` and `ChatInputPart`                                                                   | The desktop host's `ChatGPTWidgetModel` projects the ChatGPT service into Ash's transcript and composer and connects the host's model routing. |
| IDE Chat          | `ChatInputPart` in `workbench/contrib/chat/browser/widget/input/chatInputPart.ts`, hosted by `ChatWidget` | Same upstream owner, path and public class name. Sessions layout and product policy stay in Sessions.                                          |

In VS Code, `sessions/contrib/chat/browser/newChatComposerInput.ts` defines the
new-session host options and send contracts; it does not export an input widget.
`SharedChatInputComposer` delegates submission to its host and participates in the
normal Chat input command scope. Its public contract does not describe all three
Ash Agent Window products. Local Chat project pages share the Ash Chat model and
reply input. They pass the current project ID on the draft, and Sessions
management links the conversation before the first request
or voice session can start.

## Execution path

1. The Code browser or Electron entry calls `createSessionsWorkbench` to prepare
   window resources and create one `DesktopWorkbench`. `Workbench` is its
   abstract shared host; the phone presentation specified in `LAYOUT.md` remains
   unimplemented.
2. `browser/workbench.ts` creates one App Server Session provider, one
   `ISessionsManagementService`, one window `ISessionsService`, and one
   `ChatService`, then registers their frontend contracts in a window-local
   `InstantiationService`.
   Shared service descriptions are loaded by `sessions.common.main.ts` and
   collected before consumers are created. The container owns their instances;
   Sessions supplies its window-specific services in that same scope.
3. The Sessions `Workbench` creates `BrowserLayoutService` and registers
   commands, context keys, menus, keybindings, overlays, quick input, settings,
   and hover services for its own window, using the same service implementations
   as the regular Workbench.
   Sessions creates the same `WorkbenchThemeService` as the regular Workbench
   against its own document. On desktop, both renderers read the shared
   `workbench.colorTheme` setting, so changes apply to both windows.
   Both windows use the same profile `settings.json` (JSONC). The Sessions
   configuration service resolves registered `agentsWindow.default` values;
   user values override them unless `agentsWindow.readOnly` is set. Read-only
   settings ignore shared-file and language values and reject setting updates,
   while raw file edits remain shared with the regular Workbench. Settings
   inspection and reset use the active window's default. Resource revisions
   still advance for ignored edits without announcing an effective setting change.
   `WorkbenchWindow` registers the renderer window and its document styles;
   Desktop initializes its window storage through the Main `storage` channel
   before creating Parts. Main merges key updates into `workbench-state.json`
   and broadcasts revisions; the browser page uses its scoped `localStorage`
   adapter. Storage identity contains only scope and profile/workspace id;
   the product entry supplies no storage namespace. Main archives the original
   v1 document before writing v2; both adapters retire the old Code/Academy
   browser namespaces before opening scopes. Migration archives never participate
   in runtime reads. The old Desktop document is removed only after a validated,
   non-conflicting import has reached disk. Sessions retains its own profile
   and `sessions` workspace identity. The renderer lifecycle service joins
   storage and Desktop log flush before disposal; Main owns log retention.
   Pane membership and split widths are saved when their owners commit a
   change, so an immediate reload does not wait for the periodic flush.
   A hidden Sessions Part retains its saved split widths until it is visible and the
   surrounding Parts have completed their layout.
4. `DesktopWorkbenchLayout` deserializes the retained Part grid, including Code's user-arranged card tree. Titlebar,
   sidebar, sessions, editor, auxiliarybar, and panel Parts are registered; the sidebar and auxiliary Parts can be toggled,
   and Activity Bar placement follows `sessions.activityBar.location`.
   The Activity Bar runs Chat, Collaboration, Agent Teams, Projects, Code, and Design commands; Collaboration opens the shared persistent channel tree, space membership controls and Calls sidebar. Channel actions open the shared notes editor or join/start a channel call with inherited membership; notes reuse the Workbench document model and collaboration owners, and channel media requires Desktop. Agent Teams opens the existing Teams sidebar; Projects opens its retained EditorPane with search, sorting and project creation. Each project contains goals and file or folder references; the shared Project backend persists them. Materials open through the existing editor and file-picker services. The window composition owns navigation between these surfaces.
   [Creator](contrib/artifacts/README.md) provides retained editing workspaces hosted by ArtifactsEditorPane. Its editors use the independent [Canvas contribution](contrib/canvas/README.md) for spatial surfaces, viewport state and pointer capture. In Design, SidebarPart hosts Layers, EditorPart hosts the retained page, and AuxiliaryBarPart hosts Shape properties; SessionsPart is hidden. ArtifactsEditorView provides a seven-mode home and retains each workspace, viewport and selection. The editor service owns one document per mode. Design automatically saves untitled drafts in the UI profile and writes opened packages back with revision checks; reopening restores the last document. Window shutdown drains Design saves without a save confirmation and checks dirty documents in the other modes. Home and Make keep the Creator navigation sidebar and hide canvas properties. The panel views borrow the active editor's document and selection through the window-scoped Design editor service. Creator and Canvas own no Session state. Document, command, widget and file lifecycle responsibilities, geometry and persistence contracts, supported tools and validation entry points are documented in their owning directories.
   Chat hides the auxiliary bar. Code exposes Files and Changes; opening a file or comparison reveals the retained Workbench editor inside the Files card beside the conversation. Changing the composition hides and restores that editor without closing its files. Session details has been removed.
   IDE and Sessions chat items open the same lightweight Agent auxiliary chrome through `IAuxiliaryWindowService`. Each opener moves its retained conversation view into that window, preserving the composer, attachments and draft. Workbench `ChatAuxiliaryWindow` owns the shared titlebar, content mount, return control and native pin control; closing it returns the view to its opener. Desktop supplies the Electron auxiliary service, which owns the authoritative native window state.
   Mobile devices remains unavailable. The Activity Bar context menu changes its position.
   The Sessions titlebar composes the shared BrowserMenubarControl with Sessions menu IDs and visual tokens. Layout actions derive menu context keys from the layout and window Sessions service; the titlebar keeps no separate sidebar or history state. Code uses the same retained conversations with a centered new-session composer; after the first message, the input stays below the conversation. The sidebar owns the new-session control.
   Its spacing follows `sessions.layoutStyle`, independently of the IDE's
   `workbench.layoutStyle`. Both preferences use the same profile settings
   resource; changing either one updates its own window without changing
   the other window's layout. Sessions sizes, sidebar visibility, and auxiliary visibility remain
   in Sessions-owned layout storage.
   The account menu uses the shared context menu service. Its Settings action
   opens the Sessions settings page, which uses the shared setting widgets and
   configuration service. Its Return to Workbench action returns to the sibling
   Workbench window or page. Sessions configuration keys are registered for parsing
   and persistence, while the Sessions page owns their visible setting metadata;
   the regular Workbench Settings page lists only Workbench settings.
5. The window Sessions service initializes the catalog. If none is
   active, the Workbench opens one untitled Session shared by Chat and Code. Each draft becomes
   durable when the first message is sent or when the user pins, renames, archives,
   adds it to a project, or moves it to a group. Organization creates a Session
   record without submitting a request; the retained composer keeps its input,
   attachments and choices while the existing model adopts the durable identity.
   After the model catalog loads, a new Code draft captures its model and effort
   from the workspace override, the fixed profile pair, or the last explicit
   Code selection, in that order. Workspace overrides use the source directory
   and host identity. A picker change updates the conversation and the last
   selection for its host. Auto inherits the App Server's configured runtime
   model.
6. `SessionsPart` reconciles every visible selection with a retained `SessionView`.
   `SessionGridLayout` hosts these views directly in a `SerializableGrid`, without
   document editor inputs, panes, groups or tab title controls. Ordinary opens
   replace the active slot and retain sibling views. The grid owns sash sizes and
   restores Session identities from its saved tree, including migration from the
   former editor-group layout. Focus updates the window's active selection;
   closing a view does not archive its durable Session, and draft materialization
   preserves its view and composer in place.
   The product composition owns the single view-service subscription and
   pushes the window's `(visible, active)` into the passive `SessionsPart`.

After `session/catalog/subscribe`, App Server sends `session/changed` and
`session/deleted` to that connection as catalog invalidations. The provider
reads the affected Session through `session/catalog/read`, which reads only its
indexed SQLite catalog rows. The backend marks Agent tree changes in the
notification; management loads full Session details when opened or when that
tree changes. It never compares a Session
sequence because no such sequence exists.
Durable sequence and gap handling belong to the Thread-backed Chat runtime and
`session/thread/update`.

Session and branch `management` values retain the catalog’s coarse status, activity,
and summary. The sidebar announces the Session status; history labels show each
branch status. Missing branch metadata stays unknown. These values do not change
precise execution status, subscribe to background histories, select a conversation,
or overwrite a draft’s model. Rows retain their DOM identity, focus, scroll position,
and pull-request annotation as management changes.

`session.ts` is the frontend Session product boundary and re-exports the shared
Chat identity and model-reference types. Transport DTO mapping stays private to
the App Server provider. Sessions views consume `ISessionsManagementService`
and frontend-owned domain types; Workbench Chat presentation consumes its model
through a view contract and never imports the Sessions product layer.

An untitled Session captures the frontend Workspace when it opens. A single
folder supplies its execution target; a multi-root Workspace asks the user to
choose a folder when the draft becomes durable. An empty Workspace sends no
target. `session/create` carries `executionTarget` (local, SSH or Provider), never the
editor Workspace. App Server stores the execution target with the root Thread
and Session catalog. Existing Sessions keep their own target when another
Workbench hands off a chat. Local targets select a directory runtime; SSH
targets select the configured remote App Server. The frontend workspace summary
displays the stored root and does not grant access.

The composer workspace picker stores the source folder and Dev Container choice
on its untitled Session. Choosing a container does not start it. Materialization
uses the owning provider's host-scoped Dev Container service to prepare the runtime
before creating the durable Session. Concurrent drafts share an in-flight
preparation; the last waiting caller's cancellation stops that preparation.
Failure or cancellation retains the draft and never substitutes its source host.
Container configuration, provisioning and admitted runtime targets remain owned
by the Rust Provider and App Server.

Additional SSH, WSL and self-hosted Tunnel hosts share the renderer's connection
registry. `RemoteAgentHostContribution` owns their child service scopes and
`RemoteAgentHostSessionsProvider` mounts directories from the canonical Sessions
model on the same host connection. Resource authorities retain both the source
host and runtime workspace, including when two containers use the same path.
Main acquires native carriers and relays bytes; each renderer scope owns its
protocol client. WSL uses a discovered WSL 2 distribution and its independently
installed `ash-remote-server`. Tunnel exchanges the authenticated launch URL in
Main and keeps its token only for that window lease. It uses the Web session's
existing directory authorization. Disconnect retires the provider and its file
routes without falling back to another host or stopping the shared daemon.

Desktop Code Chat uses the same provider registry and host-scoped Chat routing
as the Agents window. Opening a conversation link resolves its provider
authority against the current window's connected hosts. The retained composer
uses that provider's models and execution settings, and Session and Thread
identities keep follow-up messages on the originating host.

## Failure and lifecycle semantics

- The renderer never creates a durable Session merely because the window or a
  draft opens.
- A catalog load failure still permits a window-local draft; sending or
  organizing it reports any backend failure when a durable Session is needed.
- Session and Thread mutations remain App Server-owned; management routes
  operations to the provider; the window Sessions service owns only local
  visibility, active selection, focus, and navigation history.
- Chat loading failures expose a history or live-update recovery action through
  the shared Chat widget. Recovery reloads content without sending a Turn or
  consuming the draft; selection changes and disposal retire the old action.
- Archive actions interrupt the Session tree through the management service.
  Restore uses the backend's root-Thread operation and does not restart work or
  restore child branches. Bulk restoration leaves foreground selection and
  drafts with their existing UI owner.
- Session chat popups reuse `IAuxiliaryWindowService`. `SessionsPart` moves its retained
  `SessionView` into the popup, preserving the single composer and provider scope.
  Main-window navigation leaves detached chats open; closing a popup returns its
  view to the Agent window. Archive, deletion and parent disposal release the popup.
- Each runtime, Part, retained Chat pane, App Server event subscription, and
  interaction service is disposed with the Sessions window.
- An Electron process has one Sessions window. Opening it from another
  Workbench focuses the existing window and updates its workspace context
  before handing off a chat. Its profile App Server connection remains open;
  Session requests route to their stored local or SSH roots. Closing a Workbench
  leaves the Sessions window open with its most recently selected workspace.
- Returning to Workbench closes the Electron Sessions window and focuses or
  reopens the same workspace, or navigates the browser page to its sibling
  Workbench entry.
- Academy currently has no dedicated Sessions renderer or profile.

## Tests and modification impact

- `test/browser/sessions-layout.test.ts` protects fixed topology, required
  Parts, docked Details geometry, and independent editor/detail visibility.
- `contrib/layout/test/browser/desktopLayoutController.test.ts` covers common session editor and panel state, restoration ordering, draft materialization and shutdown.
- `contrib/changes/test/browser/sessionChangesEditor.test.ts` verifies that hidden Changes editors ignore late results and reload content when shown.
- `test/browser/sessionFileService.test.ts` protects Session directory routing across
  selection changes, directory moves, and archive. `changesView.test.ts` covers stale
  responses, keyboard Diff opening, combined review, and truncated content errors.
- `test/browser/sessions-view-service.test.ts` protects selection ownership,
  multi-session visibility, history, stale references, close behavior, and
  draft materialization.
- `test/browser/sessions-part.test.ts` verifies the Sessions-owned primary Part
  passively renders multiple full Chat surfaces and reports focus/close intent.
- `test/browser/chatViewPane.test.ts` and `chatViewPane.startup.test.ts`
  protect the Session-backed regular Workbench Chat and its Agent Sessions list.
- `test/browser/workbenchSessions.contribution.test.ts` verifies the regular
  Workbench's separate Sessions service, Chat navigation, and Turn review registrations.
- `test/browser/sessions-list.test.ts` verifies that list refresh retains buttons,
  focus, and click behavior for unchanged Sessions.
- `test/browser/sessionsAccountMenu.test.ts` verifies account menu actions and
  focus state. The Sessions window smoke test checks that its Settings action
  opens the Sessions page and that its setting controls can be used.
- `services/sessions/test/browser/sessionsManagementService.test.ts` protects
  catalog refresh, provider invalidation, drafts, and operations without
  inventing Session sequence state.
- `test/browser/workspaceSelection.test.ts` protects the frontend mapping from
  empty, single-folder, and multi-root Workspaces to execution targets.
- `test/smoke/areas/sessions/sessions-window.spec.ts` verifies the dedicated
  Electron window, registered Parts, sidebar navigation actions, list search, multiple Grid leaves, close, return flow,
  and system-wide shortcut registration and release.
- `test/smoke/areas/sessions/sessions-code.spec.ts` verifies Files/Changes in Web and
  Electron, all four Editor/Details states, shared session Panel commands, protected managed tabs, file save through the real backend, and state restoration across layout changes and reload.
- `platform/windows/test/electron-main/` verifies reuse,
  close and reopen ordering, resource release, initialization failure, and IPC commands.
- `workbench/contrib/keybindings/test/electron-browser/` verifies shortcut
  selection; `platform/globalKeybindings/test/electron-main/` verifies
  active-window routing, conflict reporting, and release.

Changes to desktop topology belong in `browser/desktopWorkbench.ts`; default sizes
and frame metrics belong in `browser/layoutPolicy.ts`. Changes to window selection
belong in `services/sessions/browser/sessionsService.ts`; changes to provider
adaptation and Session catalog operations belong in `services/sessions/`. Adding a second layout or
Session model inside a Part would be architectural drift.

## Current limitations and staged evolution

The Sessions Part opens visible conversations in a horizontal row of shared editor
groups; editor drag and drop can arrange them vertically. The complete split tree
and conversation bindings restore when the window reopens, using the shared
EditorPart's layout serialization. Provider grouping,
additional search/filtering and cross-window view-state persistence are
future work. They should extend the Sessions view/layout owners without moving
product policy into base modules or the regular Workbench layout.
