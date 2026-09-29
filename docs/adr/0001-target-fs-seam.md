# TargetFs seam：按目标读写文件的逻辑收进单一 module

Status: accepted（2026-09-29）

文件 IO 在 `index.ts` 里按 local / WSL / 免密远程 / 密码远程四种目标各写了一遍：路径包含性校验三份（`resolveWithin` / `remoteFullPath` / `wslFullPath`，报错文案还不一致），写与改名的文件语义两份（`writeFileContent` 系列 vs 裸 fs 上的 `wslWrite` / `wslDelete` / `wslRename`），「该走哪条通道」两份（`session-file-reader.ts` 与散落各 handler 的分支），文件树缓存两套（`FileTreeIndex` vs 裸 Map + 字符串前缀扫键失效）。根因是**目标没有真实表示**：`resolveTarget` 把连接档案物化成伪造的 `TabInfo`，调用方靠哪个字段被填来判别种类。

决定：建立 **TargetFs** module，seam 下三个 adapter——`localFs`（真 fs）、`SFTP`（密码远程）、`ssh`（免密远程）；**WSL 不再是独立 adapter**，而是 localFs 加一个注入的 path mapper（沿用 SessionIndex 已有的 `setWslPathMapperForTests` 注入点）。引入 **`Target`** 判别联合作为唯一目标真值，`targetFromTab` 与 `resolveTargetRef` 是仅有的两个桥。缓存成为模块内部 seam：`FileTreeIndex` 泛化为 target-keyed，键从 Target 算出而非拼接 `::tree::` 字符串。模块内部 **throw 带分类**（not-found / denied / escape / transport / timeout），IPC 载荷形状与用户文案留在边界。

## Considered Options

- **让 module 内部继续读伪造 TabInfo** —— 拒绝：被判别的字段本身就是伪造产物，判别逻辑会与真实来源脱钩，等于把问题搬进新模块。
- **interface 直接收绝对路径** —— 拒绝：会保留「远程绝对、本地根相对」的不对称，迫使每个调用方先判别种类才能解释路径，正是要消灭的分支。
- **一次性把所有 TargetRef 消费者（session / model / remote）迁到 Target** —— 拒绝（本轮）：这些 handler 目前零接口级测试，回归网为空；改为文件 IO 先行，其余后续单独一刀。

## Consequences

- IPC 载荷**保留**「远程/WSL 传绝对 Linux 路径、本地传根相对路径」的不对称：abs→rel 归一发生在模块边界入口，渲染层与线上契约零改动。后人会问为什么不在协议层直接归一——因为那要同步改 `treeStore` / `ViewerPane` / `TreeOrigin` 两侧契约，与本次收益不成比例。
- 过渡期内 `resolveTarget` 仍在为 session / model / remote handler 物化伪造 `TabInfo`。规矩是**新代码不得再读伪造字段**，这些 handler 迁移完成后一并删除。
- git 通道（`diff-session.ts` 自有 `GitCtx`）与 exec 通道（`sshExec` / `sshCatRemoteFile` / `file:diagnose-mentions` 自建 `SshClient`）不在本 seam 内。若将来把 `Target` 扩成它们的共同表示，那是另一个决策。
- 「目录不存在」的语义（空列表而非错误）从 `sftp-errors.ts` 的字符串匹配变为判别错误分类，`isSftpMissingPathError` 随之退役。
