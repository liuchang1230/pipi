# 不 fork pi

我们不 fork [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)，也不维护它的补丁分支。所有定制走扩展层（`~/.pi/agent/extensions/`）与技能层（`~/.pi/agent/skills/`），代码放在本仓库、随 app 分发。

## 为什么放到界外

pi 是 MIT 许可、上游活跃维护的 agent。fork 之后我们继承的是**每一处上游改动都要人工合并**的长期成本，换来的是"能直接改内部实现"这种短期便利。而 pi 的扩展 API（`docs/extensions.md`）已经把我们要的东西都暴露了：`tool_call` 可以拦截（ADR 0003 的审批门就是这么做的）、可以注册工具、可以改 UI、可以注入系统提示。

真正稀缺的不是"改 agent 内部"的能力，是**远程 + AI 的整合**（SSH/SFTP 会话、远程会话浏览、远程模型配置）；这部分本来就在我们自己的代码里，跟 fork 不 fork 无关。分叉还会让我们跟上游的模型/协议适配脱节——那才是真正会过期的东西。

## 已有的逃生阀

- 想加一个钩子：先查 `docs/extensions.md` 有没有对应的 event。近两年新需求绝大多数落在 `tool_call`、`session_before_*`、自定义 tool 上。
- 想改行为而不是加行为：写一个**扩展 + 技能**，把偏好注入系统提示（先例：`src/main/extensions/pipi-model-sync.ts`）。
- 上游确实缺能力：提 issue / PR 给上游。这比我们私藏一个补丁便宜。
- 需要一个上游明确不做的东西（沙箱、审批弹窗这类，pi 在 `docs/usage.md` 里写明是**有意不做**）：在我们这层做，接受它只是"降低误操作概率"而不是安全边界（见 ADR 0003 的两个局限）。

## 历史请求

- 无。本文件写在任何"顺手 fork 一下"的诱惑发生之前。
