---
description: Ash TypeScript frontend layers, services, adapters, and base boundaries.
applyTo: "**/src/**/*.ts,**/src/**/*.cts,**/test/**/*.ts"
---

# TypeScript Frontend Architecture Guidelines

## Dependency direction

Preserve `base → platform → editor → workbench`. Lower layers must not import, reference, specialize for, or derive defaults from higher layers.

Keep interfaces small and complete from the caller's point of view. Every method, option, and overload must add distinct semantics.

Prefer an existing canonical context or service over options and callbacks that merely expose the same state again.

## Frontend services

- Put a frontend domain service contract in a `common/*Service.ts` file and name its public interface and service identifier `I<Capability>Service`.
- Name each runtime implementation file after its exported class, including a meaningful runtime qualifier: `appServerSyntaxAnalysisService.ts` exports `AppServerSyntaxAnalysisService`.
- Align capability names, operation semantics, lifecycle, and error categories across the frontend service, transport protocol, and backend service so adapters remain thin and mechanical.
- Name adapters and tests after the contract or implementation they exercise.

Transport APIs, generated DTOs, and wire validation stay inside the runtime adapter. Product consumers depend on the frontend service contract and frontend-owned domain types, not transport representations.

## Base layer

Modules under `src/ash/base` are domain-neutral. Higher-level features may depend on base; base must not import or mention them.

Define URI parsing, URI identity, resource collections, UUID validation, and lifecycle primitives in terms of their general contracts. Preserve exact URI identity by default; a domain that needs alternate semantics, such as ignoring fragments, selects that policy explicitly.

Domain identities and lifecycle rules remain in their owning domain.

Add general structures only for concrete domain-neutral consumers.

## Learnings

* 必需服务不得通过多层可选 options 转传。服务组合发生变化时，沿真实创建入口核对构造注入、容器注册和作用域；缺失依赖必须在创建阶段失败，不能延迟到首次打开文件时暴露。

* TypeScript 长期对象的稳定服务依赖必须在 constructor 上显式可见，由 `IInstantiationService.createInstance` 统一解析；当前端实例化体系以服务标识参数装饰器作为标准入口时，使用 `@I...Service` 声明这些依赖。options 只承载每个实例的数据、配置和宿主回调，不承载可由服务容器提供的稳定服务。禁止用 `invokeWithinContext(...getOptional)` 隐藏必需依赖，也禁止叶子对象在服务缺失时自建容器或替代实现。只有作用域 owner 可以基于注入的父容器创建子作用域并注册该作用域特有的服务；accessor 查找只用于命令或 action 的单次执行。测试应注册真实依赖并经同一创建入口装配对象。
