# Pi Hashline Edit

pi 扩展 `@criogaid/pi-hashline-edit`，注册入口为 `src/index.ts`。

## 按任务定位

- `src/core/`：内部纯函数层，无公开 API，不依赖 Pi：行拆分、checksum、文本解码、错误码，以及 edit（`apply.ts`）与 replace（`replace.ts`）的引擎。它信任工具层已筛过的输入。
- `src/pi/`：工具注册、配置、渲染、grep 与 ripgrep 进程层、文件提交和 Action Fusion。
- Use `src/pi/file-read.ts` for guarded stream and whole-file reads; keep byte revision checks in search and commit owners.
- `src/integration/`：真实后端集成测试。
- Use `src/testing/` for shared test environment and installed-package fixtures. Run suites through npm scripts to exclude inherited Node loaders and personal Pi settings.
- 改工具参数、用户可见行为或配置时，核对 `README.md` 中对应契约。
- 改 pi API、生命周期或 TUI 集成时，查看当前安装版本的 pi 文档和类型声明。
- 涉及发布时，核对 `.github/workflows/publish.yml` 与 `package.json`。

## 行为契约

- 保留结构化 JSON edits、纯函数 applicator 和批次校验；文件修改复用 `withFileMutationQueue` 与现有提交层。
- 文本编辑保留 BOM、行尾和未触及字节。无效 UTF-8、NUL 或非法单行正文应在写入前拒绝。`read` 用 Pi 的图片识别接口将受支持图片交给原生工具；含 NUL 文件也委托原生 read，其余无效 UTF-8 拒绝。
- Classify only Node's confirmed malformed UTF-8 error as `UNSUPPORTED_ENCODING`; preserve other decoder failures and their causes. Streaming validity checks catch only `Utf8DecodingError`.
- `edit` 的空正文行是实际逻辑行；末尾空行需要终止符才能保留时补上终止符，BOM-only 单行除外。非空末行保留原有最终换行状态。
- Use the shared CRLF-to-LF view for valid UTF-8 in `read/grep/edit/replace`; standalone CR and literal source escapes remain content. Map mutation offsets back to the original bytes; `write` uses the supplied full content and line endings exactly.
- Skip NUL-containing files silently in `grep`. Search invalid UTF-8 as raw bytes and display plain preview rows without edit anchors; verify the pre-search source revision and complete raw match spans in every output mode, even when the output limit omits part of a span. Preserve full byte revision checks for both preview and anchored content.
- Route tool-error previews through `src/pi/render.ts`. Use `src/pi/diagnostic-buffer.ts` for bounded stderr and search diagnostics; preserve the final cause and label omitted text.
- 行 hash 是可碰撞的位置相关 checksum。恢复候选由调用方重新提交验证；range 验证边界见 README。
- `edit/replace` 提交绑定实际读取字节的 revision。工具结果使用 `publishedRevision`；Action Fusion 以 mutation 返回的 `publishedRevision` 为 freshness 基线。
- 保留提交阶段与 `NOT_PUBLISHED` / `PUBLISHED` / `UNKNOWN` 状态，分别报告文件发布结果和后续命令结果。
- Action Fusion 通过 `ctx.executeTool("bash", ...)` 调用会话中的 Bash，遵循 override、`tool_call` 和 `tool_result` 钩子；以最终会话结果判定命令状态并向父结果传递 `terminate`，命令失败不回滚已发布文件。
- 配置字段为 `hashlineEdit`。项目 `.pi/settings.json` 的该字段整体替换全局字段；每个设置项单独校验，缺失或非法时回退默认值。类型、范围和默认值只在 `src/pi/config.ts` 的 schema 中定义。全局路径通过 `getAgentDir()` 获取。
- 工具在注册时接收解析后的配置并在生命周期内保持不变；修改配置需要 reload。

## 编码约定

- 同一条规则、常量、类型或文案只定义一次；新增代码先复用现有定义，不在调用处重写。
- 输入按漏斗处理：每个工具只有一个入口，非法输入在最上层一次性筛掉，包括 schema 表达不了的检查；下游信任已筛过的输入，不重复校验或防御，也不做兼容转换。新增防御前，先确认实际存在绕过上层的调用路径。
- 测试按生产的调用顺序驱动工具，不为仅在测试中存在的调用路径保留防御代码。
- 类型从 schema 推导，不另写同构的类型。
- 用户可见的限制和数值与 README 保持同源；提示文本中的数值由常量生成，不写死。
- 同类工具共用同一条执行流程，工具只实现自己独有的部分。
- 同一类失败（如取消、校验失败）使用一致的报错形式。
- Keep Pi argument preparation and original-schema acceptance in `argument-validation.ts`; observe prepared failures without reimplementing coercion or optional-null rules. Keep failure-only schema projection and structured aggregation in `argument-diagnostics.ts`; derive branches and choices from the declared schema, suppress only inapplicable or already explained issues, and retain independent fields with bounded native diagnostics.
- Keep the JSON argument-error envelope and its byte budget in `argument-error.ts`; retain exact field paths, omit whole issues or the argument copy with explicit markers, and never truncate serialized JSON. Use the same envelope for preparation failures.
- Keep grep scope error classification in `grep-scope.ts`: only `ENOENT` means `Path not found`; preserve other filesystem errors.
- 依赖外部引擎语义的判断交给该引擎本身，不在本地重新实现或近似。

## 测试标准

- 每条测试保护一条可对外说明的契约：README、本文件的行为契约，或一个已发生的 bug。说不出保护什么，就不写。
- 在能暴露问题的最低层级写：`core/` 纯函数优先，其次是工具层，最后才是跨工具流程。能在 `apply.test.ts` 里测的边界，不经文件系统在 `execute.test.ts` 里测。
- 工具层测试通过 `callTool` 按生产顺序驱动，不为测试开辟生产中不存在的调用路径。
- 优先断言行为和状态：文件字节、`publishedRevision`、返回结构、错误码。提示语只断言关键部分，预算数值引用 `budgets.ts` 的常量，不写死。
- 同一契约只测一遍。多个输入变体用表驱动；`edit` 与 `replace` 等共用流程的行为，写成一个共享用例跑多个工具。
- 渲染测试必须断言用户可见的具体内容。只验证“不抛错”的用例不写。
- 修复 bug 时补一条回归测试，并先确认它在旧代码上失败。行为契约变更时，同一提交里改写保护旧契约的测试，不留给 CI 去发现。
- 不为覆盖率写测试，不测私有实现。
- 一条测试只因一种原因失败；名字写成“条件 → 行为”。
- 依赖真实 ripgrep、超大文件或平台差异的测试放 `src/integration/`，不进每次提交都跑的 `npm test`。

## 验证

按改动影响选择检查：

- 格式：`npm run format:check`（自动格式化为 `npm run format`）。
- 类型：`npm run typecheck`。
- 单文件测试：`node --test src/pi/execute.test.ts`（按需替换路径）。
- core 和 pi 测试：`npm test`。
- 真实后端集成：`npm run test:integration`；组合运行用 `npm run test:all`。

本地类型检查和测试可直接运行，修复本次改动导致的失败后重跑受影响检查。报告实际结果及平台跳过项。

独立测试进程读取磁盘源码；通过当前 Pi 会话验证已加载的扩展行为时，需要用户 `/reload` 或重启。等待重载期间继续完成独立检查。纯文档改动核对事实、路径和 diff 即可。

## 提交与发布

- Derive the commit scope from the affected feature or owning module (for example, `grep`, `edit`, `replace`, `file-commit`, `fusion`). For cross-cutting changes, use the narrowest shared capability; never use the package name as scope.
- AI 辅助提交附加 `Co-Authored-By: <模型名> <邮箱>`，模型名和邮箱都由执行提交的 coding agent 按自己的署名填写（例如 Claude Code 使用 `noreply@anthropic.com`，Pi 使用 `noreply@pi.dev`），不读取环境变量。
- 提交时不纳入 `docs/` 下的文件。
- push、版本、tag 和发布动作按用户授权及实际 workflow 执行。
- `.github/workflows/publish.yml` 由 `v*` 标签推送触发；依次运行类型检查与完整测试、校验标签与包版本一致，再通过 npm provenance 发布。
