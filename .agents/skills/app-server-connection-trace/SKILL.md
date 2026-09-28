---
name: app-server-connection-trace
description: Trace and improve Ash Desktop startup, Electron-to-App-Server connection, daemon cold start, reconnect, and Workbench readiness. Use for latency across Electron Main, Renderer, the daemon, and Rust App Server; not for Cargo compile time or memory leaks.
---

# App Server connection performance trace

Use this skill when a Desktop startup or reconnection feels slow, or when an optimization claim spans Electron and Rust. Produce a timeline that identifies the slow boundary, then compare the same scenario before and after a change. A process starting, a socket accepting, an `initialize` response, and a usable Workbench are four different results.

## Trace the actual chain

Read the current call path before placing markers; these are the present owners:

| Stage | Owner |
| --- | --- |
| Resolve workspace, validate backend program, create window | `app-ts/src/ash/code/electron-main/app.ts` |
| Accept Renderer connection and launch daemon command | `app-ts/src/ash/platform/app-server/electron-main/appServerConnectionRelay.ts` |
| Acquire port, initialize protocol and workspace | `app-ts/src/ash/platform/native/electron-browser/rendererApi.ts` |
| Start or reuse managed process, probe `initialize`, relay bytes | `ash-rs/app-server-daemon/src/client.rs` and `process.rs` |
| Open shared profile and directory runtime | `ash-rs/app-server/src/managed/registry.rs` and `local.rs` |
| Construct visible Workbench | `app-ts/src/ash/workbench/electron-browser/desktop.main.ts` |

In the current flow, Main's `startAppServerWithRecovery` runs before window creation, but `AppServerConnectionRelay.start()` only validates the program when no Renderer is attached. `attach()` launches the daemon command after the Renderer requests a connection. The daemon probes `initialize` before handing over the connection; the Renderer then performs its own protocol initialization. Treat these as distinct spans. Recheck the source if the flow changes.

## Capture

1. Define one end state before timing: first window, successful protocol `initialize`, workspace permission setup, or usable Workbench. For Workbench, use Playwright to wait for `document.readyState === 'complete'`, a visible `.ash-workbench`, and a visible editor group. Do not use a screenshot as the pass condition.
2. Record the build identifier, OS, CPU, profile path, workspace, backend binary, selected connection mode, credential fixture, and whether a daemon was already running. Use one binary and one workspace for a comparison. Keep failed and timed-out runs in the results with their errors; never count them as fast starts.
3. Run separate cohorts for a fresh profile with no daemon, an existing profile with a stopped daemon, and a live daemon reused by a new connection. Run an Electron UI-only cohort with matched profile state and Workbench mode to bound the frontend portion. Repeat each cohort at least five times when comparing changes, alternate baseline and candidate runs where practical, and report individual samples and the median. A fresh profile also measures first-run storage work; do not call it only a process cold start.
4. Capture these milestones where observable: Electron launch request, window created, Renderer acquire request, daemon command spawned, managed endpoint ready, daemon probe response, Renderer `initialize` response, workspace initialization complete, and Workbench ready. Record each event's process, run ID, phase, elapsed time, and result. Use request/connection IDs to connect related events. Measure an interval with one process's monotonic clock or at a single observer boundary. Do not subtract timestamps from independent process clocks without clock alignment.
5. Save machine-readable runs and a concise timeline under an ignored `.build/startup-trace/<run-id>/` directory. Preserve the raw trace or logs that support each phase. Redact credentials and home paths before sharing artifacts.

For a cheap backend baseline, separately launch `ash-app-server --listen stdio://` and measure `spawn → valid initialize response`, then measure `ash-app-server-daemon connect-selected` to the same response. These are **different scopes** from Desktop readiness, so compare them as clues, not additive components of a single run. Use the repository's `app-ts/test/automation/electron.ts` launch configuration and `test/automation/workbench.ts` readiness contract rather than inventing a weaker selector.

A standalone development binary may need the product-services fixture and packaged helper tools to initialize. Missing credentials, `tgrep`, or another required resource is a failed run, even if the process exits quickly. Use an isolated test profile and test credentials when needed; never borrow a user's login to make the benchmark pass.

## Run the repeatable Desktop baseline

After preparing the development backend package and Electron build, run from the repository root:

```sh
ASH_CONNECTION_TRACE=1 pnpm --dir app-ts exec playwright test test/smoke/areas/windows/connection-trace.spec.ts --project=electron-app-server
```

The test is opt-in and skips during ordinary smoke runs. It records five launches in each cohort: a new profile without a daemon (including the first-run trust choice), one authorized profile whose daemon is stopped between launches, one authorized profile with a reused daemon, and UI-only startup with an authorized profile and the same workspace. Every sample gets a new Electron user-data directory; the OS file cache is not cleared. The reused cohort checks that the daemon PID stays the same.

The report is attached to the Playwright result and saved at `.build/startup-trace/desktop-<run-id>/connection-trace.json`. Read its individual samples and errors alongside the medians; it also records the build ID, backend size, platform, readiness condition, and cache and profile conditions. The measured interval starts immediately before `launchElectron` in the Playwright worker and ends when its Workbench readiness check finishes. It includes automation and first-run interaction time. It does not isolate Electron process creation, the daemon probe, protocol initialization, or CPU work; use the detailed tracing steps below for those spans. Do not turn a single build's median into a fixed CI latency threshold.

For behavior coverage, `app-ts/test/smoke/areas/windows/home.spec.ts` verifies that an authorized workspace reopens after its backend stops. The trace test measures duration while also requiring successful readiness; it does not replace that regression test.

## Collect detailed traces only for the slow stage

- If Main or Renderer is busy, capture an Electron/Chromium trace or CPU profile and analyze it with [cpu-profile-analysis](../cpu-profile-analysis/SKILL.md). Distinguish CPU work from idle time waiting for a process, socket, IPC, or disk.
- If the daemon or Rust runtime is slow, add narrowly scoped `Instant` spans at the owning Rust boundaries and correlate them with the connection ID. Use the same low-overhead instrumentation for baseline and candidate runs, and verify release behavior without diagnostic overhead if it could affect the result. Do not infer Rust's internal cost from the Electron total.
- Rust's WebSocket span exporter is configured by `ASH_TRACE_WEBSOCKET_ADDR` and `ASH_TRACE_WEBSOCKET_TOKEN` for a directly launched App Server. Check `app-ts/src/ash/platform/app-server/common/appServerEnvironment.ts` before relying on it for Desktop: the current Electron environment allowlist does not forward those keys. A shell variable alone does not prove that Rust spans were captured.
- Inspect the daemon's initial `initialize` probe and the Renderer's later initialization separately. The probe establishes backend readiness and compatibility; any proposal to remove or combine it needs the same failure and version checks covered in the new path.

## Evaluate and report

Use a stage table with per-run samples, median, and error count. State which interval includes process spawn, profile open, probe, protocol negotiation, workspace setup, and rendering. Name the measured bottleneck and show its raw evidence. For a proposed fix, repeat the exact cohorts on the same machine and build type; compare both the affected stage and end-to-end Workbench readiness. A faster `--version` or socket open alone does not establish a faster usable Desktop.

Example conclusion: “Fresh-profile Workbench readiness improved by 240 ms median across seven valid runs; the daemon `spawn → probe` interval accounts for 190 ms of that change. Reused-daemon readiness changed by 8 ms. Renderer CPU trace shows no new long task.” Replace these values with measured results; do not report a cause from subtraction alone.

Stop only processes and delete only profiles created for the trace. Do not stop a user's shared daemon or copy their real credentials into an artifact. When code changes follow the repository's matching TypeScript, Rust, and testing instructions, and use Playwright for Electron UI verification.

## Learnings

- Close each test Electron window before stopping its managed daemon. Stopping the daemon while its Renderer is still running triggers reconnect and can turn cleanup into a test-only initialization timeout.
