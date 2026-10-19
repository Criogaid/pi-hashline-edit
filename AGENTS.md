# Pi Hashline Edit

pi 扩展 `@criogaid/pi-hashline-edit`，注册入口为 `src/index.ts`。它替换 Pi 内置的 `read`、`grep`、`edit`、`write`，并新增 `replace`。

## 按任务定位

- 改 `src/core/` 前读 `src/core/AGENTS.md`，改 `src/pi/` 或 `src/index.ts` 前读 `src/pi/AGENTS.md`：模块职责和该层的实现约束只写在那里。
- `src/core/`：不依赖 Pi 的纯引擎（行处理、checksum、解码、错误、edit、replace、JavaScript 搜索），无公开 API。
- `src/pi/`：工具注册、配置、参数校验、报告与渲染、grep 与 ripgrep 进程层、regex worker、文件提交和 Action Fusion。
- `src/integration/`：真实后端集成测试；`src/testing/`：共享测试环境与安装包 fixture。
- 改工具参数、用户可见行为或配置时，核对 `README.md` 中对应契约（工具参数、输出预算、恢复语义、发布状态）。
- 改 pi API、生命周期或 TUI 集成时，查看当前安装版本的 pi 文档和类型声明。
- 运行时 `typebox` 由 Pi 的扩展加载器提供（peer 依赖）；devDependency 精确锁定为 `@earendil-works/pi-coding-agent` 依赖的同一版本，升级 Pi 时同步。
- 涉及发布时，核对 `.github/workflows/publish.yml` 与 `package.json`。

## 行为契约

- 保留结构化 JSON edits、纯函数 applicator 和批次校验；文件修改复用 `withFileMutationQueue` 与现有提交层（`src/pi/file-commit.ts` 是唯一发布路径）。
- 文本编辑保留 BOM、行尾和未触及字节。无效 UTF-8、NUL 或非法单行正文应在写入前拒绝。`read` 用 Pi 的图片识别接口将受支持图片交给原生工具；含 NUL 文件也委托原生 read，其余无效 UTF-8 拒绝。
- Classify only Node's confirmed malformed UTF-8 error as `UNSUPPORTED_ENCODING`; preserve other decoder failures and their causes. Streaming validity checks catch only `Utf8DecodingError`.
- `edit` 的空正文行是实际逻辑行；末尾空行需要终止符才能保留时补上终止符，BOM-only 单行除外。非空末行保留原有最终换行状态。
- Use the shared CRLF-to-LF view for valid UTF-8 in `read/grep/edit/replace`; standalone CR and literal source escapes remain content. Map mutation offsets back to the original bytes; `write` uses the supplied full content and line endings exactly.
- Skip NUL files in grep. Keep invalid UTF-8 output as plain preview rows; matching uses the lossy preview text. Content mode re-reads each matched file and keeps it only when that read has the revision it was matched on; files and count modes report the searched snapshot without re-reading.
- Validate grep patterns and flags with V8 at tool entry; resolve case overrides once into `GrepQuery.flags`. Native `RegExp` in `src/core/search.ts` decides every grep match on the LF view; rg only lists candidates and never decides a match. Candidate derivation may widen but never narrow.
- 行 hash 是可碰撞的位置相关 checksum。恢复候选由调用方重新提交验证；range 验证边界见 README。
- `edit/replace` 提交绑定实际读取字节的 revision。Action Fusion 以提交层返回的 `publishedRevision` 为 freshness 基线；revision 不进入工具结果。
- Return successful mutations as one report without anchor rows; keep anchors in read/grep output and edit failure diagnostics. Keep diffs in mutation details for the TUI.
- 不为旧版本保存的数据（会话回放中的结果、报告、Fusion 卡片）保留兼容：格式变更直接破坏性更新，旧数据按非法输入处理；唯一例外是会导致 Pi 崩溃的输入。
- 保留提交阶段与 `NOT_PUBLISHED` / `PUBLISHED` / `UNKNOWN` 状态，分别报告文件发布结果和后续命令结果。
- Action Fusion 通过 `ctx.executeTool("bash", ...)` 调用会话中的 Bash，遵循 override、`tool_call` 和 `tool_result` 钩子；以最终会话结果判定命令状态并向父结果传递 `terminate`，命令失败不回滚已发布文件。
- 配置字段为 `hashlineEdit`。项目 `.pi/settings.json` 的该字段整体替换全局字段；每个设置项单独校验，缺失或非法时回退默认值。类型、范围和默认值只在 `src/pi/config.ts` 的 schema 中定义。全局路径通过 `getAgentDir()` 获取。
- 工具在注册时接收解析后的配置并在生命周期内保持不变；修改配置需要 reload。
- Derive output byte budgets only from the selected model's declared capacity, never remaining context; an explicit `read.maxKiB` overrides only the read cap.

## 编码约定

- 同一条规则、常量、类型或文案只定义一次；新增代码先复用现有定义，不在调用处重写。
- Give each model-facing rule one home, chosen by what it decides. Choosing a tool, or a parameter of the call being written, belongs in that tool's `description` or the field's description; an obligation spanning several calls belongs in `promptGuidelines`; what to do about one result belongs only in that report's `next` (`src/pi/report-schema.ts`). State a tool's or field's facts once, where they belong. Guidelines never restate a `next`; `NEXT_GUIDELINE`, appended at registration in `src/index.ts`, ranks a report's `next` above them. Word rules as instructions with a concrete trigger and listed exceptions, not as preferences. Include text that applies to one platform only on that platform, decided from `process.platform` where the text is defined.
- 输入按漏斗处理：每个工具只有一个入口，非法输入在最上层一次性筛掉，包括 schema 表达不了的检查；下游信任已筛过的输入，不重复校验或防御，也不做兼容转换。新增防御前，先确认实际存在绕过上层的调用路径。
- 测试按生产的调用顺序驱动工具，不为仅在测试中存在的调用路径保留防御代码。
- 类型从 schema 推导，不另写同构的类型。
- 用户可见的限制和数值与 README 保持同源；提示文本中的数值由常量生成，不写死。
- 同类工具共用同一条执行流程，工具只实现自己独有的部分。
- 同一类失败（如取消、校验失败）使用一致的报错形式。
- Every tool result states its facts in one report (`src/pi/report-schema.ts` defines each field, its owner, and each code's facts and recovery; `src/pi/report.ts` builds and serializes it as one JSON object). A success report follows the content payload; a failure report is the whole `isError` result. Layers return structured facts and never append sentences or bracket notices; each fact has one owner, so it appears once. Throw sites classify failures as `HashlineError` with a code and the facts its schema requires; `message` describes only the throwing step, a failure beneath that step is `cause`; native diagnostics remain directly in `message`, without a synthetic wrapper, and `next` is derived from the code and publication (a throw site may only select one of the code's named alternatives). Text shared by success and failure (such as `REREAD`) is defined once in the schema module.
- 依赖外部引擎语义的判断交给该引擎本身，不在本地重新实现或近似。

## 测试标准

- 每条测试保护一条可对外说明的契约：README、AGENTS.md 的行为契约，或一个已发生的 bug。说不出保护什么，就不写。
- Do not use Claude for new model-backed experiments.
- 在能暴露问题的最低层级写：`core/` 纯函数优先，其次是工具层，最后才是跨工具流程。能在 `apply.test.ts` 里测的边界，不经文件系统在 `execute.test.ts` 里测。
- 工具层测试通过 `tool-call.testing.ts` 的 `callTool` 按生产顺序驱动，包括非法输入，不为测试开辟生产中不存在的调用路径。
- 优先断言行为和状态：文件字节、返回结构、错误码。提示语只断言关键部分，预算数值引用 `budgets.ts` 的常量，不写死。
- 同一契约只测一遍。多个输入变体用表驱动；`edit` 与 `replace` 等共用流程的行为，写成一个共享用例跑多个工具。
- 渲染测试必须断言用户可见的具体内容。只验证“不抛错”的用例不写。
- 修复 bug 时补一条回归测试，并先确认它在旧代码上失败。行为契约变更时，同一提交里改写保护旧契约的测试，不留给 CI 去发现。
- 不为覆盖率写测试，不测私有实现。
- 一条测试只因一种原因失败；名字写成“条件 → 行为”。
- 依赖真实 ripgrep、超大文件或平台差异的测试放 `src/integration/`，不进每次提交都跑的 `npm test`。

测试布局：`*.test.ts` 与源码相邻。`registration.test.ts` 覆盖配置接线，`read.test.ts` 覆盖 read，`execute.test.ts` 覆盖 edit 与共享 mutation 流程，`failure-path.test.ts` / `result-safety.test.ts` 覆盖发布失败与结果安全，`argument-validation.test.ts` 经工具入口覆盖组合参数失败。`src/testing/session.testing.ts` 负责 Pi 会话初始化、本地模型响应流、凭据与资源隔离和清理，工具上下文和 Fusion 会话共用它，注册与业务断言留在各功能里。`process.testing.ts` 提供干净的子进程环境，`installation.testing.ts` 创建只含锁定生产依赖的源码或 npm 归档安装，`extension-loader.testing.ts` 经 Pi 的 jiti 与虚拟模块加载它们；`src/integration/npm-package.test.ts` 覆盖归档包的工具注册、worker 和命令分发。
The `src/pi/grep-order.test.ts` suite controls worker and file-read completion order to verify deterministic rows, warnings, and limit cutoffs; `src/integration/grep-order.test.ts` verifies repeated real-rg output and row prefixes as the limit increases.

## 命令

TypeScript runs directly through Node's type stripping, without a build step. CI runs Node 24 on Linux, macOS, and Windows, plus Node 22.19.0 and 26 on Linux. Local formatting, type checks, tests, and benchmarks need no confirmation.

- `npm run format:check` / `npm run format`：Biome，只管格式，范围为 `src/` 与 `bench/`。
- `npm run typecheck`：`tsc --noEmit`，覆盖源码与测试。
- `npm test`：经 `src/testing/run-tests.ts` 在隔离的 Node 环境和临时 Pi agent 目录中运行 core 与工具测试，排除继承的 Node loader 和个人 Pi 设置。
- 单个用例：`npm test -- --test-name-pattern "<regex>"`，`npm run test:integration` 同样适用。不要直接运行 `node --test`，它绕过环境隔离。
- `npm run test:integration`：bundled ripgrep、已安装包的 worker、超过 100 MiB 的文件。`npm run test:all` 运行两套隔离测试，与 CI 和发布一致。
- `npm run test:cartesian`：只跑两套测试中名为 `Cartesian …` 的笛卡尔积矩阵，耗时以分钟计；其余命令与 CI 均跳过它们。改正则翻译、候选推导或预筛后手动运行。新增笛卡尔积矩阵测试时名称以 `Cartesian ` 开头。
- `npm run bench`、`node --expose-gc bench/grep-memory.bench.ts`：吞吐与 grep 内存；`node bench/argument-validation.bench.ts`：参数准备加 Pi 校验，不执行工具。

报告结果时注明平台跳过项。独立测试进程读取磁盘源码；通过当前 Pi 会话验证已加载的扩展行为时，需要用户 `/reload` 或重启，等待期间继续完成独立检查。纯文档改动核对事实、路径和 diff 即可。

## 提交与发布

- Derive the commit scope from the affected feature or owning module (for example, `grep`, `edit`, `replace`, `file-commit`, `fusion`). For cross-cutting changes, use the narrowest shared capability; never use the package name as scope.
- AI 辅助提交附加 `Co-Authored-By: <模型名> <邮箱>`，模型名和邮箱都由执行提交的 coding agent 按自己的署名填写（例如 Claude Code 使用 `noreply@anthropic.com`，Pi 使用 `noreply@pi.dev`），不读取环境变量。
- 提交时不纳入 `docs/` 下的文件。
- push、版本、tag 和发布动作按用户授权及实际 workflow 执行。
- `.github/workflows/publish.yml` 由 `v*` 标签推送触发；依次运行类型检查与完整测试、校验标签与包版本一致，再通过 npm provenance 发布。
