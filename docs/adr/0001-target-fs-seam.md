# TargetFs seam：按目标读写文件的逻辑收进单一 module

Status: accepted（2026-09-29）

文件 IO 在 `index.ts` 里按 local / WSL / 免密远程 / 密码远程四种目标各写了一遍：路径包含性校验三份（`resolveWithin` / `remoteFullPath` / `wslFullPath`，报错文案还不一致），写与改名的文件语义两份（`writeFileContent` 系列 vs 裸 fs 上的 `wslWrite` / `wslDelete` / `wslRename`），「该走哪条通道」两份（`session-file-reader.ts` 与散落各 handler 的分支），文件树缓存两套（`FileTreeIndex` vs 裸 Map + 字符串前缀扫键失效）。根因是**目标没有真实表示**：`resolveTarget` 把连接档案物化成伪造的 `TabInfo`，调用方靠哪个字段被填来判别种类。

决定：建立 **TargetFs** module，seam 下三个 adapter——`localFs`（真 fs）、`SFTP`（远程读写）、`ssh`（会话文件快路径，即不按凭据分而按用途分，见下方修正）；**WSL 不再是独立 adapter**，而是 localFs 加一个注入的 path mapper（沿用 SessionIndex 已有的 `setWslPathMapperForTests` 注入点）。引入 **`Target`** 判别联合作为唯一目标真值，`targetFromTab` 与 `resolveTargetRef` 是仅有的两个桥。缓存成为模块内部 seam：`FileTreeIndex` 泛化为 target-keyed，键从 Target 算出而非拼接 `::tree::` 字符串。模块内部 **throw 带分类**（not-found / denied / escape / transport / timeout），IPC 载荷形状与用户文案留在边界。

## 实施中修正（2026-09-29，读路径接线时）

- **SFTP / ssh 不是「按有没有密码」分。** 初版写的是「密码 ⇒ SFTP，免密 ⇒ ssh」，接线时发现那会把免密远程的预览与 `@` 补全全部打死：`withSftp` 的 auth 走 `remoteAuthOptions`，本来就能用 agent / 默认私钥连上免密服务器，旧的 `remoteReadFile` 正是无条件走 SFTP。真实分工是**用途**而非凭据：SFTP 是远程浏览/预览/mention 的唯一通道（`sftpTarget`，构造时不再看密码）；`ssh cat` 只是**会话文件快路径**（`sshTarget`），它的价值是不占 SFTP 租约、且在远端 pi 死掉时仍可读——这条规则原本归 `session-file-reader.ts` 所有，现由 `targetFromTab` 承担。
- **远程 tab 有两个根，payload 说用哪个。** `remoteBrowsePath`（可变的浏览根）与 `remote.path`（项目根）在旧码里就分属不同操作：树的绝对行、写入/改名/删除的包含基准是浏览根；mention 的相对路径解析在项目根。因此 `resolveFileTarget` 按 `mention` 选根。若强行只留一个根，要么浏览到项目外就被判越界（旧码允许），要么 mention 解析到错目录。
- **过滤规则统一，且进缓存键——但只在模块内部生效。** 旧码本地树过滤噪音、远程/WSL 不过滤；模块的过滤选项已按「树 `tree`，选择器与 mention 索引 `all`」统一，mention 两条 walk 也走 `all`。但 `file:list` / `file:list-dir` **两个通道各自沿用旧过滤**（local 过滤，远程/WSL 不过滤），不按「树」统一：这个 handler 同时服务项目树与目录选择器（`RemoteDirPicker` 就靠它浏览），而 wire payload 本轮不加 filter 字段（见下方 Consequences：载荷形状不变）。把远程树也过滤掉，代价就是选择器再也选不到 `.worktrees` / `build` / `node_modules` 里的项目——这不是「更干净」，是功能丢失。同一目录的两种过滤必须各自成键，否则会互相投毒；mention 索引走 `fresh`：它在旧码里每次都是实时 walk。
- **路径校验看解析结果。** `readPreview` / `writeText` / `mkdir` / `remove` / `rename` 只判「解析后是否仍在根内」：`src/../readme.md` 合法，`../x` 与 `/etc/passwd` 被拒，对根自身操作也拒。代价是远程 markdown 里指向项目外的 `../` 链接不再可读（旧 `remoteReadFile` 对非 mention 读取是 `requireWithinBase=false`）。
- **「目录不存在」在树边界退化为空。** 模块抛 `not-found`，`file:list` / `file:list-dir` 转成 `[]`；权限与传输错误照旧上抛。旧行为把两者都当空列表，于是不可达的远程项目看起来就是空项目（CONTEXT：那个「远程文件刷新中…」事故）。
- **not-found 文案带 `No such file`。** 渲染层（`viewerStore` 的自动跟随重试、`FileViewer` 的「文件不存在」分支）按这个字样判别。模块自造的错误文案若只剩自己的措辞，等于静默砍掉那条重试路径。
- **写路径（③）也走模块，失败文案留在边界。** `file:write` / `file:mkdir` / `file:delete` / `file:rename` 现在同样经 `resolveFileTarget` + 模块的 `writeText` / `mkdir` / `remove` / `rename`（`rootPath` 与 tab 两条 payload 读法从此合流）。模块抛分类错误（`invalid-name` / `exists` / `not-found` / `escape`），中文文案表（`mutationErrorText`，在 `target-fs-channels.ts`）逐字沿用旧串：`已存在同名文件: x` / `目标已存在: x` / `路径不存在: x` / `名称不合法（不能包含 / 或 \）`。同一个 `exists` 有两种读法（mkdir 被文件占位 vs 改名撞名），用 `newName` 是否存在区分——这不是措辞细节，是避免每通道各写一张文案表。代价：远程/WSL 的 mkdir / remove / rename 会多一次 `stat`（这是分类错误与「路径不存在」判定的代价）；名称校验的尾随点/空格只在 win 目标拒绝（Windows API 会静默截掉，`x.` 会落到 `x`），posix 目标照写。
- **未连线前的过渡（仅 slice ②）。** ② 落地时写入/改名/删除还是旧实现，但它们失效的是旧缓存；读路径已改看模块缓存，所以当时的 `mutateFile` 额外调了模块的 `invalidate`（用与读路径同一个 target，否则键不同、等于没失效）。③ 收编这四个 handler 后这层手动失效就删了。
- **无 cwd 的 tab 不再回落到 `process.cwd()`（②③ 共同的行为变化）。** 旧码在 tab 没有 cwd 时把文件操作落到 app 自己的进程目录，也就是把用户的文件写到安装目录里；现在报错。读路径与写路径一致；同理，根不是绝对路径的远程档案（`path` 写成相对路径）现在直接报错，而不是“先半成功后失败”。

## Considered Options

- **让 module 内部继续读伪造 TabInfo** —— 拒绝：被判别的字段本身就是伪造产物，判别逻辑会与真实来源脱钩，等于把问题搬进新模块。
- **interface 直接收绝对路径** —— 拒绝：会保留「远程绝对、本地根相对」的不对称，迫使每个调用方先判别种类才能解释路径，正是要消灭的分支。
- **一次性把所有 TargetRef 消费者（session / model / remote）迁到 Target** —— 拒绝（本轮）：这些 handler 目前零接口级测试，回归网为空；改为文件 IO 先行，其余后续单独一刀。

## Consequences

- IPC 载荷**保留**「远程/WSL 传绝对 Linux 路径、本地传根相对路径」的不对称：abs→rel 归一发生在模块边界入口，渲染层与线上契约零改动。后人会问为什么不在协议层直接归一——因为那要同步改 `treeStore` / `ViewerPane` / `TreeOrigin` 两侧契约，与本次收益不成比例。
- 过渡期内 `resolveTarget` 仍在为 session / model / remote handler 物化伪造 `TabInfo`。规矩是**新代码不得再读伪造字段**，这些 handler 迁移完成后一并删除。
- git 通道（`diff-session.ts` 自有 `GitCtx`）与 exec 通道（`sshExec` / `sshCatRemoteFile` / `file:diagnose-mentions` 自建 `SshClient`）不在本 seam 内。若将来把 `Target` 扩成它们的共同表示，那是另一个决策。
- 「目录不存在」的语义（空列表而非错误）从 `sftp-errors.ts` 的字符串匹配变为判别错误分类；`isSftpMissingPathError` 降级为 SFTP adapter 内部的细节（`stat` 探到缺失时回答 `null` 而不抛，否则 `withSftp` 会用一次正常探测销毁池化租约）。
- 重建已完成：读路径（slice ②）、写/改/删（slice ③）、删除副本（slice ④）。已删：`remoteReadFile` / `wslListFiles` / `remoteListFiles` / `remoteFileTreeCache` 及其 get/set/key/invalidate 一套（后者的失效作用于无人读的废缓存）、`session-file-reader.ts` 与其测试、`file-tree.ts` 的本地写/改/删函数（`writeFileContent` / `createDirectory` / `deletePath` / `renamePath` / `isValidName` / `opError` / `FileOpResult`）与只为它们存在的 `RemoteFileNode` 类型。
- **还没搬完的部分（已知，下一刀）。** `file-tree.ts` 里仍留着**第二份预览策略**：`readFileContent` / `readPreviewFromAbs` / `readSlice`、三个预览常量（`target-fs.ts` 自己也各有一份）与 `listFiles` / `pathInfo`——它们在生产代码里已无调用者，只靠 `file-tree-read.test.ts` 养活（那条预览行为已由 `target-fs.test.ts` 的 44 例覆盖）。另外模块仍从 `file-tree.ts` 取 `isBinaryBuffer` / `imagePayloadOf` / `rasterImageMimeOf` 三个帮手（模块自己的策略却依赖旧文件）。真正还在生产路径上的只有 `resolveWithin`（`file:reveal`）与 `listDirChildren`（`FileTreeIndex` 的真实 fs walker，主要由它自己的测试用）。收尾 = 把三个帮手搬进模块 + 删掉那份死预览与它只覆盖死码的测试；本轮没做是为了不动已商量好的范围。
