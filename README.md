# OMP Echo Memory

项目内人格与记忆扩展，适用于 oh-my-pi（omp）；不是独立模型服务。Node.js 24+，无 npm 运行依赖；另行安装 omp。当前版本 **1.1.0-beta.1**，通过 [GitHub 仓库与测试预发布](https://github.com/gulanthys/omp-echo-memory/releases) 分发，不发布 npm。

## 安装与初始化

把仓库克隆为已有项目的**直接子目录**，然后回到该项目根目录操作：

```sh
git clone --branch v1.1.0-beta.1 https://github.com/gulanthys/omp-echo-memory.git omp-echo-memory
node omp-echo-memory/cli.mjs init
node omp-echo-memory/cli.mjs status
node omp-echo-memory/launch.mjs
# 或选择实际可用的模型
node omp-echo-memory/launch.mjs --model "provider/model-id"
```

不要在插件仓库内运行这些命令。`init` 创建随机项目 ID 与物理根路径绑定，将通用 `persona.example.json` 初始化为本地 `persona.json`；不调用模型，不创建 `.runtime`。可编辑本地人格。重复初始化不覆盖已有有效配置或数据，缺失的人格文件才从模板补齐。外项目绑定、损坏配置、身份不匹配的状态、无绑定的旧 `.runtime`、符号链接/junction 或配置硬链接均拒绝处理，不自动重新绑定或迁移。不得靠删除绑定、改写项目 ID/路径来共享旧数据。

`persona.json`、`project.json` 与 `.runtime/` 为私有本地文件，已忽略且不在包文件白名单中；公开源码只提供模板。不要提交自己的配置、核心身份、聊天记录、模型凭据或运行目录。

## 显式启动与隔离

普通 `omp` 不会自动扫描或激活本插件。不要全局安装、复制到用户扩展目录或添加全局配置。手动 `-e omp-echo-memory/index.mjs` 而没有授权项目专用环境，也不会激活。

启动器仅给子进程设置项目专用目录：

- `omp-echo-memory/.runtime/omp/`：omp 状态、认证和模型配置；可在 `models.yml` 配置服务，建议引用环境变量。
- `omp-echo-memory/.runtime/sessions/`：会话日志。
- `.runtime/omp-config.yml`：关闭 omp 内置记忆与自动学习，避免第二套共享记忆。

启动器禁用全局扩展、skills/rules/context 自动发现、LSP 和 `OMP_PROFILE`，固定 `always-ask` 审批。允许 `--model`、`--thinking`、`--mode`、`--no-ui` 和显式项目内扩展；拒绝改写 cwd、profile、session-dir 或 config。不会修改父 shell、全局配置或用户扩展。

**凭据边界**：启动器不复制全局状态，但仍继承父进程环境，包括 API Key 或 OAuth Token；omp 及获准启动的工具可能使用它们。需要凭据隔离时，从干净 shell 仅设置本项目凭据。插件不访问外部记忆服务，也不在后台另调模型。

每次访问重新检查项目根 cwd、主 Agent 身份、专用环境、会话路径与项目绑定。数据路径拒绝符号链接/junction，配置与状态拒绝硬链接；损坏或外项目数据报错而不重置。仅支持绑定项目根，不自动授权子目录、worktree 或嵌套项目。

这是**插件访问隔离，不是 OS 沙箱**；不能限制同权限本机程序、已获准的工具、用户导出的会话、供应商日志或 omp 自身的缓存/更新管理。

## 独立使用与桥接

记忆插件不依赖任何 QQ 桥接。[OMP QQ Bridge](https://github.com/gulanthys/omp-qq-bridge) 是可选的独立项目。安装到同一项目后，明确组合：

```sh
node omp-echo-memory/launch.mjs -e omp-qq-bridge/index.mjs
# 替代桥接也必须是项目内真实存在的扩展文件
node omp-echo-memory/launch.mjs -e other-bridge/index.mjs
```

`-e` 可重复指定不同扩展，拒绝项目外路径、链接、目录和重复文件，不根据目录存在偷偷加载。也可用 QQ 启动器显式加载 `omp-echo-memory/index.mjs`；模型配置和主会话日志属于所选启动器，记忆始终属于本插件。共享模型、Key、进程或 profile 不意味着共享记忆。远程聊天不是本机授权，不得作为 `/omp-echo-memory` 操作者命令执行。

### 公共提供者协议 v1

协议由本仓库定义，使用 [omp 的共享事件总线](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)，不是 omp 内置长期记忆协议。主会话同步发现：

```js
const offers = [];
pi.events.emit('project-memory:resolve', {
  version: 1,
  projectRoot: ctx.cwd,
  accept(provider) { offers.push(provider); },
});
```

提供者在首次 `await` 前调用 `accept`。零响应表示未加载，多个响应必须报冲突，不能任取一个。消费者检查版本、项目归属和工具描述。发现可以早于 `session_start`，数据操作必须在就绪之后；会话切换或关闭使旧句柄失效。

- `version: 1`、`id: 'omp-echo-memory'`、`projectRoot`：版本、提供者 ID、物理项目根。
- `tools`：`{name,label,description,parameters}` 数组，参数为可序列化 JSON Schema。
- `prepare(prompt, context?)`：返回或异步返回 `{persona,memories}`；只读，背景是不可信资料，不得升级为指令或授权。
- `execute(name,args,{origin,signal,requestConsent})`：执行已声明工具；来源须真实，取消后不提交，所有持久修改须经可信本机确认。

原生提供者使用当前主会话 UI，忽略调用者自带的批准回调。无界面、拒绝、取消、项目变化或失效句柄均不提交；错误不得静默退回无记忆执行。本地可信 SDK 可导入 `omp-echo-memory/api`（项目内路径为 `omp-echo-memory/api.mjs`），调用 `openProjectMemory(projectRoot, directory)`；宿主必须提供可信 `requestConsent` 与有效取消信号，不能采用模型或聊天文本提供的批准结果。不要直接导入 `lib/` 或读写状态来绕过策略。

可选可信上下文：`{channel:'qq',selfId:string,chat:{type:'private'|'group',id:string},messages:[{messageId:string,senderId:string|null}]}`；本机 hook 为 `{channel:'local'}`。桥接必须取实际传输 ID，不能从正文、昵称、引用或转发中构造。逐条识别身份，不因同群或同批次扩展身份；缺失或非法上下文视为未知来源。QQ 策略/元数据放在系统策略，正文保持不可信。可信本机插件能伪造参数，该协议不是对恶意本机代码的认证沙箱。

其他项目内启动器须在子进程设置 `OMP_PROJECT_ROOT`、`OMP_PROJECT_AGENT_DIR`、`OMP_PROJECT_SESSION_DIR`，并使 `PI_CODING_AGENT_DIR` 与 agent 目录一致，禁用 `OMP_PROFILE`。目录和会话文件必须在本项目内且不是链接。记忆启动器自己的环境命名空间为 `OMP_ECHO_MEMORY_PROJECT_*`；没有旧名称别名。

## 记忆、人格与本机管理

模型工具名保持 `echo_memory` 和 `echo_persona`。工具发起的所有持久修改额外请求本机确认。人格成长仅允许 `humor`、`warmth`、`initiative`、`curiosity`、`expression`、`collaboration`，须有记忆证据，pending 提案不会自行应用；批准、拒绝和撤销仅限操作者入口。人格不扩大工具权限，模型推断不成为事实或授权。

```text
/omp-echo-memory help
/omp-echo-memory status
/omp-echo-memory persona
/omp-echo-memory remember {"content":"偏好先给结论","type":"preference","source":"user","evidence":"用户明确提出"}
/omp-echo-memory recall 结论
/omp-echo-memory inspect 记忆ID
/omp-echo-memory history
/omp-echo-memory approve 提案ID
/omp-echo-memory reject 提案ID
/omp-echo-memory revert 提案ID
/omp-echo-memory forget 记忆ID
```

CLI 无需模型或 Key，在项目根执行，操作与上述 `help` 相同：

```sh
node omp-echo-memory/cli.mjs status
node omp-echo-memory/cli.mjs persona
node omp-echo-memory/cli.mjs list
node omp-echo-memory/cli.mjs recall "结论"
node omp-echo-memory/cli.mjs core
node omp-echo-memory/cli.mjs core-set '{"qq":"123456789","relationship":"项目协作者","address":"协作者","meaning":"项目合作关系，不表示远程工具授权"}'
node omp-echo-memory/cli.mjs core-clear
```

`core` 为独立核心身份，缺省 `null`；`core-set` 完整替换，`core-clear` 清除，三者仅限本机操作者，不在模型工具或公共 `execute` 开放。字段只能是 `qq`、`relationship`、`address`、`meaning` 四个非空字符串；QQ 为无前导零的 5–20 位数字，关系/称呼各最多 100 字符，含义最多 2000 字符。示例数字须替换；不保存秘密。核心身份独立附加在每次人格策略中，优先于普通人格、成长和召回，但不覆盖安全规则、不授予 QQ 工具/审批权限；普通记忆和成长不能改它。旧 v1 状态缺少 `core` 时只读为未配置，不迁移写盘；非法配置报错。

**隐私**：核心配置全部字段会随人格策略发送给所用模型，包括其他用户的会话；它不是秘密库。`core-clear` 不删除会话或供应商日志。传输身份策略不保证模型永不误称。

记忆采用 Unicode/CJK 词法检索，无向量服务，不保证同义理解；不自动收集整段聊天。保留强度为 `2^(-间隔天数/半衰期)`；基础半衰期 event 7 天、preference 90 天、learning 60 天、relationship 180 天、context 30 天，初始值再乘 `0.5 + importance`。这些是工程初值，不是认知实测参数。

- 强度低于 0.08 不参与普通召回，但可 inspect 或 `includeDormant:true`；衰减不删原文。
- 读取/检索/提示准备不强化；新独立事件经确认后强化，事件 ID 去重且至少间隔 24 小时；半衰期最多为基础值的 16 倍，importance 不超过 1。最多 1000 个事件哈希，满后拒绝新增。
- `correct` 创建替代记录，旧内容不再普通召回，清理派生记忆与相关成长；旧原文可在 inactive 历史查看。
- `consolidate` 将至少两条 active 记忆归档并保存摘要和引用链；摘要标为 inferred，插件不另调模型。
- `forget` 不可逆删除指定记录及递归派生记录、相关成长；撤销成长不能恢复已删依据。

forget 不删除已有会话、消息、曾注入上下文、备份或供应商日志，也不安全擦盘。需停用旧上下文时新建会话并自行管理保留策略。凭据检查仅识别部分常见格式，不能代替敏感信息审核。

## 升级、备份与故障

升级前停下本项目启动器/omp，离线备份 **`project.json`、`persona.json` 和整个 `.runtime/`**，包括核心身份、记忆、模型配置和会话。只更新源码与模板；不要覆盖受保护的本地文件，不重新生成项目 ID。模板更新不覆盖已有 persona。插件目录更名不改变项目身份；仅在物理项目根保持原样时保留旧绑定，移动整个项目或复制到其他项目不会自动迁移。新项目应使用全新检出并执行 init，不复制旧运行目录。

`.runtime/state.json` 包含 v1 状态、事务 revision、稳定项目 ID/物理根、记忆、成长及可选 core。独占锁与临时文件原子替换避免部分事务提交，但不等于数据库级断电恢复。遇到 `.runtime/state.lock`，先确认进程已退出再手动清理；活跃进程持锁时不要删除。损坏文件不自动覆盖或重置。

## 验证与 beta 限制

在项目根（macOS 可使用物理临时目录以避免 `/var` 别名与路径绑定冲突）：

```sh
TMPDIR=/private/tmp npm --prefix omp-echo-memory test
TMPDIR=/private/tmp npm --prefix omp-echo-memory run smoke
```

本测试版已在 Node 24.22.2 下通过 41 项行为回归和真实 omp 18.18.0 RPC 烟测，覆盖初始化/重复初始化的数据保留、外项目及孤立状态拒绝、路径隔离、发现/召回、无界面确认隔离、保存/审批/重启/删除。烟测模型请求数为 0，不代表付费模型或真实 QQ 验收。打包后的公开运行文件已在全新项目中实际执行 init、status、core 与重复 init，未创建运行状态，也未依赖本机人格和绑定。既有受控模型身份场景不保证长期人格效果或模型永不误称。

Beta 尚不承诺跨物理根迁移、恶意本机进程隔离、数据库级恢复、语义检索准确率或模型始终正确遵循人格。未接入设备、语音或硬件；不提供自动更新和全局安装。发行变更见 [CHANGELOG](CHANGELOG.md)。
