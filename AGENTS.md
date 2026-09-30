# 战略备忘

## 产品定位
远程 AI 编程工作台，不是"终端壳"。卖点 = 在远程服务器上跑 AI 编程（SSH/SFTP 会话、远程会话浏览、远程模型配置）。

## 核心判断
- **agent（pi）不是我们的资产**：MIT 开源、上游维护。价值核心是"远程 + AI"的整合层，不是 agent 本身。
- **不 fork pi**：分叉税（永远追上游）不可承受。定制全部走扩展层：
  - 扩展示例：`~/.pi/agent` npm 包的 `examples/extensions/`（`ssh.ts` 是远程执行种子）
  - 增强代码放本仓库，随 app 分发到 `~/.pi/agent/extensions/` 和 `skills/`
  - 探索路径：痛点 → 复制示例 → `~/.pi/agent/extensions/` + `/reload` 热加载试错 → 迁移进 app
- **不当 API 中转商**：法律/合规风险、价格战、压资金、无粘性。默认 BYOK（用户自带 key），app 只做"配置便利化"（模型一键配置模板：DeepSeek/硅基流动/Kimi/智谱 + 自定义 OpenAI 兼容端点）。

## 文档地图
- `GLOSSARY.md` — 领域词汇（唯一语言；`domain-modeling` 技能只认这个文件）
- `docs/invariants.md` — 6 条硬规则 + 稳定性契约：**引用规则时引这里**
- `docs/architecture-decisions.md` — 52 条带日期的架构决策（决策 + 理由 + 当时定的契约）
- `docs/adr/` — 少数需要完整「动机 / 决策 / 后果」的决策，引用时给 `file:line`
- `docs/diagnosis/<YYYY-MM-DD>.md` — 按日期的调试记录（历史，按需读，别整读）
- `.out-of-scope/` — 明确不做的方向（有人再提，先读这里）

## 变现
本地免费开源（open-core）；付费点 = 远程/团队/便利功能，与 API 成本无关。

## 下一步
1. 读 `ssh.ts` 示例，做"本地输入、远程执行"扩展原型
2. 模型一键配置模板（国内合规渠道 + 自定义端点）
3. 补 LICENSE
