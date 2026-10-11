---
description: Ash TypeScript frontend layers, services, adapters, and base boundaries.
applyTo: "**/src/**/*.ts,**/src/**/*.cts,**/test/**/*.ts"
---

# TypeScript Frontend Architecture

## Frontend services

- A DI-managed domain service shared across runtimes puts its contract in the owning domain's `common` layer and names its public interface and identifier `I<Capability>Service`. Preserve an established VS Code counterpart's contract filename when aligning APIs.
- Multiple callers or asynchronous work alone do not justify a service class or `common/*Service.ts`. Place provider interfaces, request orchestration and helpers using [source organization](source-code-organization.instructions.md).
- Runtime implementation filenames match their exported class, including the runtime qualifier: `appServerSyntaxAnalysisService.ts` exports `AppServerSyntaxAnalysisService`. Adapters and tests use the contract or implementation name.
- Transport APIs and wire validation stay inside the runtime adapter.

## Dependency Injection

- Stable service dependencies of long-lived objects are explicit constructor parameters with `@I...Service` decorators, resolved by `IInstantiationService.createInstance`.
- Register singleton implementations with `registerSingleton(IMyService, MyServiceImpl, InstantiationType.Delayed)`.
- Options carry per-instance data, configuration and host callbacks, not stable services from the container. Do not pass required services through optional options or hide them behind `invokeWithinContext(...getOptional)`.
- Missing required registrations must fail during creation. Leaf objects must not create fallback containers or implementations.
- Only a scope owner may create a child container from its injected parent and register scope-specific services. Accessor lookup is limited to a command or action's single execution.

## NLS boundary

`src/ash/nls.ts` is the shared root NLS entrypoint and may depend only on `base`. Layer checks must allow that entrypoint and check its dependencies; do not move it into `base/common` merely to satisfy a path assertion.
