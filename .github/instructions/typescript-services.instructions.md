---
description: Ash TypeScript service contracts, dependency injection, registration and scope ownership.
applyTo: "**/src/**/*.ts,**/src/**/*.cts,**/test/**/*.ts"
---

# TypeScript Services and Dependency Injection

## Service contracts

- A DI-managed domain service shared across runtimes puts its contract in the owning domain's `common` layer and names its public interface and identifier `I<Capability>Service`. Preserve an established VS Code counterpart's contract filename when aligning internal editor or Workbench APIs. Ash extension author APIs (`@ash/sdk`, `ash.*`, `sdk/typescript`) follow the Ash capability contract in [extension architecture](../../docs/editor-extensions.md#统一后端扩展接口规范), not VS Code extension API compatibility; existing internal service ownership and dependency injection still apply.
- Multiple callers or asynchronous work alone do not justify a service class or `common/*Service.ts`. Place provider interfaces, request orchestration and helpers using [source organization](source-code-organization.instructions.md).
- Runtime implementation filenames match their exported class, including the runtime qualifier: `appServerSyntaxAnalysisService.ts` exports `AppServerSyntaxAnalysisService`. Adapters and tests use the contract or implementation name.
- Transport APIs and wire validation stay inside the runtime adapter.

## Dependency Injection

- Stable service dependencies of long-lived services, controllers and UI components are explicit constructor parameters with service-identifier decorators such as `@IConfigurationService`, resolved by `IInstantiationService.createInstance`. Put per-instance arguments before injected service parameters. Calling `createInstance` while manually passing services does not satisfy this contract.
- Options carry per-instance data, configuration and host callbacks, not stable services from the container. Do not disguise required dependencies as optional fields or recover them through `invokeWithinContext`, `getOptional`, or a stored container/accessor.
- Register default singleton implementations with `registerSingleton(IMyService, MyServiceImpl, InstantiationType.Delayed)` in the owning runtime registration entrypoint. Application bootstrap and registration factories may assemble the service graph and supply host-owned instances; consumers must not construct concrete service implementations or introduce module-level service instances.
- Missing required registrations must fail during creation. Leaf objects must not create fallback containers or implementations. Genuine runtime-optional capabilities need an explicit availability contract owned by the runtime composition boundary, not optional lookup scattered through consumers.
- Only a scope owner may create a child container from its injected parent and register scope-specific services. It must dispose that scope with its window, editor or session. Injected services are borrowed; callers own `createInstance` results and supplied instances, while the container owns services it constructs from registrations.
- Outside bootstrap and registration factories, accessor lookup is limited to a command or action's single execution. Inject `IInstantiationService` to construct children or own a scope, not to locate the object's stable dependencies; never retain an invocation accessor for later work.
- Plain models, value objects, pure helpers and `base` UI primitives without container service dependencies may use ordinary parameters and `new`. Do not turn every class into a registered service or introduce service dependencies into `base`.
- When changing a service dependency, migrate the affected production creation paths and test/fixture setup together. Verify assembly through the production creation path, including failure when a required registration is absent; follow [test writing guidelines](writing-tests.instructions.md#unit-tests-and-fixtures).
