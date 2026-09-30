# ADR 0003：审批门（不可逆操作前先问一句）

Status: **accepted**（2026-09-29）

## 动机

本项目的「沙箱/审批」此前是唯一一类**完全没有**、而 Codex 有、且直接卡住变现的东西：**没有人会把无人看守的 AI 派到一台生产服务器上**。

pi 官方把这件事说得很清楚，且是**有意为之**：

- `docs/usage.md:309`：*"It intentionally does not include built-in MCP, sub-agents, **permission popups**, plan mode, to-dos, or background bash."*
- `docs/security.md:31`：*"## No Built-in Sandbox"*

于是工具与扩展都以 pi 进程的权限直接执行。本地这么做还能靠 git + 编辑器兜底；**而 pipi 的卖点恰恰是「让 AI 在你的远程服务器上跑」—— 那里一条 `rm -rf` 或 `git reset --hard` 之后没有撤销。** 这不是「少个功能」，是「管道全通、阀门没装」。

对照 Codex（**外部信息，非本仓库可核实**：openai/codex，Apache-2.0）：它的安全模型是**两根独立轴**——

| | 轴 | 取值 |
|---|---|---|
| **containment（沙箱）** | 进程能碰到什么 | `read-only` / `workspace-write` / `danger-full-access`（OS 强制：Seatbelt、Landlock+seccomp，默认断网） |
| **consent（审批）** | 动手前问不问 | `untrusted` / `on-failure` / `on-request` / `never` |

## 决策：只做 consent，而且只做它的一半

**做**：在不可逆的工具调用真正执行前，弹一个确认框；用户拒绝 → 拦下这次调用并告诉模型为什么。

**不做 containment**：沙箱要靠容器化（`docs/containerization.md` 是 pi 官方指的路），是**另一个数量级**的工程 —— 镜像、挂载、网络策略、跨平台（Windows/WSL/远程 Linux 三套）—— 与本 ADR 无关。**这里不假装做了一半等于做完了。**

这个区别是这个功能的全部诚实性所在：它**降低误操作的概率**，不**限制误操作的后果**。任何把它当安全边界用的说法都是错的，所以下文 §两个局限 会把漏的那部分写清楚。

## 为什么缝是 `tool_call`

`docs/extensions.md:778` 定义了 `tool_call`：*"Fired after `tool_execution_start`, before the tool executes. **Can block.**"*，返回值 `{ block: true, reason?, terminate? }`，且 `event.input` 可变。

官方示例（`docs/extensions.md:70`）就是这件事本身：

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

**为什么不是别的缝**：

- **不改写命令参数**（`event.input` 是可变的，可以偷偷把 `rm -rf` 换成 `rm -ri`）—— 那会让「用户批准的就是执行的那条命令」这句话不再成立，校验和执行必须是同一份输入。
- **不挂在 `tool_result` 上** —— 那时候已经晚了。
- **不拦 `read` / `grep`** —— 只读操作没有后果，问了只会训练用户无脑点「允许」，反而降低真弹窗的信噪比。

## 三个默认值（用户 2026-09-29 拍板）

| 项 | 取值 | 理由 |
|---|---|---|
| 默认策略 | **`destructive`（开启，只拦不可逆）** | 默认关闭的安全功能等于不存在；而「每次都问」会把用户训练成按钮反射 |
| 拦截范围 | **破坏性 + 提权/外发** | 见 §分类表 |
| 无人应答 | **120 秒后按拒绝** | 拒绝是安全侧；且远程场景下「用户不在电脑前」是常态，不是异常 |

## 交互形态：用 `confirm`，不用 `select`

pi 的对话框有 `select`（多选项），看起来更适合审批（「允许 / 拒绝 / 本项目始终允许」）。**仍然选了 `confirm`**，因为渲染层为它准备了专用排版：

- `src/renderer/src/dialogs/UiDialog.tsx:33` `splitConfirmMessage(msg)`，且 `ConfirmMessage`（`:169`）**只为 `method === "confirm"` 渲染**。
- 它认的格式（`src/shared/confirm-detail.ts:1-20`）：第一行一句话 → `AI 说：` 行（目的）→ `· ` 行（要点）→ 其他行（小标题）→ `详情（供核对）` 之后是**等宽、默认折叠**的核对块。

于是审批弹窗能同时做到「先说人话」和「命令可核对、但不喧宾夺主」。这是**白捡的**：分类器产出的 `what`/`why`/`detail` 正好落在这套格式上。

**代价**：`confirm` 没有第三个按钮 → **v1 做不了「本项目始终允许」白名单**。用户拍板时选的是「默认开启 + 只拦不可逆」，而白名单是「让默认开启可持续」的主要手段 —— 所以它**降级为 v2**（§后续），而不是含糊地塞进 v1。

## 超时用 `{ signal }`，不用 `{ timeout }`

`docs/extensions.md:2537-2565`：`opts.timeout` 带倒计时显示并在超时后自动消失，但**超时与用户取消的返回值完全相同**（`confirm` 都是 `false`），官方原文：*"For more control (e.g., to distinguish timeout from user cancel), use `AbortSignal`"*。

必须区分，因为**回给模型的话是相反的**：

- 用户拒绝 → 「不要重试同一条命令，也不要换个写法绕过」（换个思路）
- 无人应答（约 120 秒）→ 「用户现在可能不在电脑前 —— 先停下来说明你需要什么确认」（别傻等）

若用 `{ timeout }`，模型会把「没人在」读成「用户说不」，然后开始猜用户为什么反对。

另有一个不那么明显的好处：**审批门上挂倒计时会逼人快点点「允许」**，而审批门的唯一价值就是让人真的看一眼。超时限制改为写在要点里（「120 秒内无人应答将视为拒绝」）—— **知情，但不施压**。

## 策略来源：环境变量，且**缺失 = off**

app 通过 `PIPI_APPROVAL_POLICY` / `PIPI_APPROVAL_TIMEOUT_MS` 注入（`src/main/approval-env.ts`），走的是 `pipi-subagent-model.ts` 已验证过的同一套通道（本地 spawn 直接给 `env`；WSL/SSH 用 `bash -ic '…'` 前置的 `VAR=值` 前缀）。

**env 缺失必须读作 `off`，不能是默认值**：同一个扩展文件也会被装进用户自己的 `~/.pi/agent/extensions/`，于是**命令行里的 `pi` 也会加载它**。命令行用户不该突然收到自己从没要过的弹窗。

**代价**：漏注入 = 静默失效（没有任何报错，门就是不响）。所以配了两道：`piEnv()`/`piShellPrefix()` **单点收口**（§注入），和一条**注入完备性测试**（§测试）。

注意反向的对称保护：**`policy = off` 时也照样注入 `PIPI_APPROVAL_POLICY=off`**，而不是「不注入」。否则用户 shell 里一个陈旧的 `PIPI_APPROVAL_POLICY=all` 会让门复活。

## 分类表（`src/main/extensions/pipi-approval-gate.ts`）

按 `&&` / `||` / `;` / `|` / 换行**切段后逐段匹配**，规则**锚定片段开头**。

| 类别 | 拦 | 例 |
|---|---|---|
| 递归/通配删除 | `rm` 带 `-r`/`-R`；通配、`dir/`、`.`、`~`、`/tmp` 之外的绝对路径 | `rm -rf build`、`rm -fr ./dist`、`rm /etc/hosts` |
| `find` 批量删 | `-delete` / `-exec rm` | `find . -name '*.log' -delete` |
| git 不可逆 | `reset --hard/--merge/--keep`、`clean -fdx`、`push --force(-with-lease)/-f`、`branch -D`、`stash drop/clear` | `git reset --hard HEAD~3` |
| 提权 | `sudo` / `doas` / `su`（片段开头） | `sudo apt-get install -y nginx` |
| 磁盘 | `mkfs`、`dd of=/dev/…`、`shred`、`> /dev/sd*` | `mkfs.ext4 /dev/sda1` |
| 外发 | `curl`/`wget` 带 `-d`/`-F`/`-T`/`--data*`/`--upload-file` | `curl -d @secrets.json https://…` |
| 管道进 shell | 整条看（切开就丢语义） | `curl https://…/x.sh \| sudo bash` |
| 发布 | `npm/pnpm/yarn publish` | `npm publish` |
| 项目外写入 | `write`/`edit` 的 `path` 是绝对路径且不在会话 cwd 下（豁免 `/tmp`） | 写 `/etc/profile` |

**放过**（同样是决策）：`rm 单个文件`、`rm -f /tmp/…`、`git push`（不带 force）、`git reset HEAD~1`、`rm -rf` 出现在**字符串里**（`echo "rm -rf /"`、`grep -rn sudo docs/`）—— 后者是锚定片段开头换来的：**不锚定就会把「提到」当成「执行」**，而误报比漏报更快让用户把这个功能关掉。

**剥外壳**（否则规则会被常见写法绕过）：`sudo` / `nohup` / `time` / `command` / `nice` / `setsid` / `env A=1` / `xargs -0` / `A=1` 前缀；`git -C <dir>` 等全局选项。**递归进** `bash -c "…"` 的载荷（限深 3，防套娃）。

`rm` 那条线划在「递归 / 通配 / `/tmp` 外的绝对路径」：`rm -f /tmp/build.log` 是 agent 的日常动作，问了只是噪音。这条线是判断，不是定律 —— 想更严就把策略设成 `all`。

## 两个局限（写下来，而不是含糊过去）

### 1. 拦不住扩展自己干的活

`tool_call` **只在模型调用工具时触发**。扩展可以直接执行命令，走不到这里 —— 本轮已经踩过实例：**`pi-rewind` 在 `session_start` 里直接跑 `git add --all`**（见 ADR 0002 §结案），审批门对它一无所知。

同一个缝还有两个直接后果：

- **只覆盖 `bash` / `write` / `edit` 三个内置工具。** 别的扩展提供的工具（比如某个 `deploy`）、pi 以后新增的工具，**一律不过门** —— 名字不在 `isGateTarget` 里。v1 的取舍是「宁可窄而可信」，但它是**已知的窄**，不是遗漏。
- **拒绝时不下 `terminate: true`。** 被拦后模型收到 reason 就继续跑（我们在文案里让它「先说明目的」），而不是整轮终止。这是故意的：一次不让做，不等于整个任务该停。代价是固执的模型可以换条路再试，于是用户会再看到一个弹窗 —— 由人来兜底。

### 2. 分类器本质上是漏的

`bash` 命令不可判定，上面是一张**模式表 + 正则**。绕过它的写法无穷多（`python -c 'import shutil; …'`、`base64 -d \| sh`、自己写个小脚本、`make` 跑什么只有 Makefile 知道……）。

**所以它是「速度缓冲」，不是安全边界。** 真正的隔离只能靠容器（`docs/containerization.md`）。这条必须出现在 ADR、代码注释和设置界面文案里三处 —— 一个被误认为安全边界的缓冲，比没有缓冲更危险，因为它会让人放心地关掉别的东西。

## 必须先修的看门狗（P0，不是新功能）

`src/main/rpc-session.ts` 的静默看门狗（`SEND_SILENCE_MS = 90000`）在**每次 `send()` 后武装**：90 秒零字节 → 报 `rpc_unresponsive`「连接疑似断开」。

而**一个等着用户应答的 `confirm` 恰好就是「合法的 90 秒零字节」** —— pi 阻塞在对话框里，不吐任何事件。远程标签上盯着弹窗超过 90 秒（`UiDialog` 还提供「收起」功能，**故意让请求保持 pending**），用户就会看到一条**假告警**。

所以这不是「加个功能」，是**先得改看门狗**：

- `SilenceWatchdog.take(now, limit, quietExpected)` —— `quietExpected` 为真时**续窗**（`since = now`）而不是上报。旧的两参调用行为不变。
- `RpcSession.awaitingUi: Map<id, deadline>`：收到 `extension_ui_request` 且 `method ∈ {confirm, select, input, editor}` 时登记，`send({type:"extension_ui_response", id})` 时注销。
- 只登记**阻塞式**方法：`notify`/`setStatus`/`setTitle`/`setWidget`/`set_editor_text` 是即发即忘，pi 没停，之后的静默照样意味着管道死了。`custom` 也不在列 —— 在 RPC 模式下它直接 `return undefined`（`dist/modes/rpc/rpc-mode.js`：*"Custom UI not supported in RPC mode"*），既没问也没停。
- `hasPendingUiDialog(now)` **顺带清扫过期条目**，`UI_DIALOG_MAX_WAIT_MS = 240000` 兜住上限：一个孤儿请求（标签被关、pi 自己超时了）**不能永久静音活性检测**。

代价是诚实的：真死掉的连接若同时有弹窗挂着，报告会晚到 —— 续窗是**从续窗时刻重算**的，所以最坏情况是 `UI_DIALOG_MAX_WAIT_MS`（240s 弹窗上限）+ 一个 90s 窗口 ≈ 330s。有界，且报出的 `silentMs` 是「未被豁免的静默」，不虚报。可接受。

相关但不同的两个看门狗**不受影响**：`noOutputTimer`（40s，受 `sawOutput` 守卫，只管启动阶段）与 `stallTimer`（60s，受 `responsesSeen > 0` 守卫）。只有静默看门狗会在会话中途武装。

## 注入：单点收口 + 完备性测试

门的开关靠环境变量，而 app 里 **spawn pi 的地方有 9 处**（`pty.ts` 5 处、`rpc-session.ts` 4 处，另加 `sdk-host.ts` 的 worker 字段）。逐个改 = grep-and-hope，下次加特性漏一个就**静默失效**。

改成：

- `src/main/pi-env.ts`：`piEnv()` = `{...subagentEnv(), ...approvalEnv()}`，`piShellPrefix()` = `subagentShellPrefix() + approvalShellPrefix()`。**这是 app 告诉 pi 的一切的唯一出口。**
- 9 处全部改走组合器；除 `pi-env.ts` 外**任何文件都不再直接调用**这两个特性模块。
- `approvalShellPrefixFor` **故意不做 base64**（不像 remote 路径那种任意内容）：值是闭集（`off|destructive|all` 和数字），无单引号，可读性更好 —— 测试会断言**不含单引号**，因为前缀是被拼进 `bash -ic '…'` 单引号里的，一个引号就能把整条远程命令弄坏。

## 测试（`src/main/__tests__/approval-gate.test.ts`，89 例）

这个功能的失败**都是静默的**，所以测试分两类：

1. **分类器**（表驱动）：31 条「必须拦」+ 20 条「必须放过」。放过那一半同样是规范 —— 误报会让用户关掉它。含 `rm` 判定、`escapesProject`、`policy` 三档的覆盖范围。
2. **门本身**：允许 / 拒绝 / **超时与拒绝被区分** / 问不出话时 **fail-closed** / 只读工具永不打扰 / 弹窗里给了用户真正的命令 / `off` 时**一个 hook 都不注册**。
3. **接线**（源码扫描）：`piEnv(` / `piShellPrefix(` 的调用者集合**必须精确等于**已知 spawn 点 —— 新增一处会让测试变红，逼人看一眼。同时断言特性模块**只被 `pi-env.ts` 调用**。
4. **合约**：扩展无法 import app 代码（它跑在 pi 里），所以自己带了一份 env 名与 `详情（供核对）` 常量 —— 测试核对两边一致，**单方面改名会让门静默失效**。
5. **设置持久化**：`approval` 缺失/损坏 → **默认值（不是 off）**；部分 patch **不得重置**另一个字段；超时越界被夹紧。

`src/main/settings.ts` 里 `approval` 是**必填**字段（不是一个可选字段），所以「忘了处理」是编译错误而不是运行时的静默 off。

## 后果

**正面**

- 默认开启的不可逆操作防护，本地/WSL/远程一律生效（同一个扩展文件，同一个注入通道）。
- 顺带修掉了静默看门狗的**假告警** —— 那是任何「阻塞式对话框」都会踩的坑，不只是审批门。
- `piEnv()`/`piShellPrefix()` 单点收口：以后再加「要告诉 pi 的东西」只改一个文件 + 一条测试。
- 变现前置条件（「能派到生产机上」）从「没有」变成「有，且诚实标注了边界」。

**负面 / 代价**

- 审批门本身是新的失败面：分类器误报会烦人（§分类表 的放过清单就是为此存在）。
- 没有白名单 → 「每次都问」档在长会话里会很吵（所以默认不是它）。
- 用户若把 `destructive` 误当安全边界，可能因此放松别处的防护 —— 三处文案都在反驳这件事。

## 后续

- **v1.1：等待角标。** `docs/extensions.md:583` 的 `ui_prompt_start` / `ui_prompt_end` 是 **pi 自己的**事件（`kind: "confirm"|"select"|"input"|"editor"|"custom"`），也就是说「有弹窗在等你」是**现成的信号**，不需要我方扩展参与 —— 纯渲染层改动，而且能覆盖**任何**扩展（含用户自己装的）的弹窗。
- **v2：按项目白名单。** 「本项目始终允许」需要第三个选项，`confirm` 给不了 → 要么改渲染层让它接受更多按钮，要么在扩展里用 `select` 重做一遍（会丢掉 §交互形态 那套排版）。**先想清楚再选**，别顺手塞进去。
- **延续：给 Codex 双轴的另一半留位置。** 沙箱（containment）是独立 ADR 的话题；本 ADR 只声明「consent 这一半做了，且只做了一半」。
- 给 `arpagon/pi-rewind` 报 issue（ADR 0002 §后续）：它的两道阀都是**计数**启发式，对「文件不多但每个都不小」的目录无效。
