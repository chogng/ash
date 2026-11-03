---
description: Routes Agents Window work to its on-demand development skill.
applyTo: "**/src/ash/sessions/**"
---

# Agents Window

For implementation, review or design in this area, use the [sessions skill](../../.agents/skills/sessions/SKILL.md).

For visual work, apply the [shared design rules](design-philosophy.instructions.md) with the Agent Window-only additions and overrides in [Sessions style](../../src/ash/sessions/STYLE.md). Shared token registration and CSS variable naming follow [design-tokens.instructions.md](design-tokens.instructions.md).

## Learnings

* 在 Ash Sessions 中实际运行演示或测试会话时，只使用 6 Luna。如果 6 Luna 不可用，报告阻塞，禁止自动切换到其他模型。
