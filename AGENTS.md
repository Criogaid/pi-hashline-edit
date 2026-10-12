# Pi Hashline Edit

pi 扩展 `@criogaid/pi-hashline-edit`，注册入口为 `src/index.ts`。

## 按任务定位

- Keep `src/core/` independent of Pi: line handling, checksums, decoding, errors, edit (`apply.ts`), replace (`replace.ts`), and JavaScript search (`search.ts`). Core engines trust inputs validated at tool entry.
- `src/pi/`：工具注册、配置、渲染、grep 与 ripgrep 进程层、文件提交和 Action Fusion。
- Use `src/pi/file-read.ts` for guarded stream and whole-file reads; keep byte revision checks in search and commit owners.
- Define replacement rules in `src/core/replace-schema.ts` and search results in `src/core/search-schema.ts`. Validate worker replies with `src/pi/regex-worker-contract.ts`; keep shared worker lifecycle in `src/pi/regex-worker.ts` and cause transport in `src/pi/report-cause.ts`. Workers trust inputs validated at tool entry and never import the Pi runtime.
- `src/integration/`：真实后端集成测试。
- Use `src/testing/` for shared test environment and installed-package fixtures. Run suites through npm scripts to exclude inherited Node loaders and personal Pi settings.
- 改工具参数、用户可见行为或配置时，核对 `README.md` 中对应契约。
- 改 pi API、生命周期或 TUI 集成时，查看当前安装版本的 pi 文档和类型声明。
- 涉及发布时，核对 `.github/workflows/publish.yml` 与 `package.json`。

## 行为契约

- 保留结构化 JSON edits、纯函数 applicator 和批次校验；文件修改复用 `withFileMutationQueue` 与现有提交层。
- Plan `copy/move` in `src/core/apply.ts` against original line ranges; capture text and separators without moving or duplicating the file-header BOM. Treat source reads separately from mutation conflicts, keep destinations in original coordinates, reject interior move destinations, and make adjacent moves no-ops. Reuse the shared commit and Fusion pipeline.
- 文本编辑保留 BOM、行尾和未触及字节。无效 UTF-8、NUL 或非法单行正文应在写入前拒绝。`read` 用 Pi 的图片识别接口将受支持图片交给原生工具；含 NUL 文件也委托原生 read，其余无效 UTF-8 拒绝。
- Classify only Node's confirmed malformed UTF-8 error as `UNSUPPORTED_ENCODING`; preserve other decoder failures and their causes. Streaming validity checks catch only `Utf8DecodingError`.
- `edit` 的空正文行是实际逻辑行；末尾空行需要终止符才能保留时补上终止符，BOM-only 单行除外。非空末行保留原有最终换行状态。
- Use the shared CRLF-to-LF view for valid UTF-8 in `read/grep/edit/replace`; standalone CR and literal source escapes remain content. Map mutation offsets back to the original bytes; `write` uses the supplied full content and line endings exactly.
- Skip NUL files in grep. Keep invalid UTF-8 output as plain preview rows; matching uses the lossy preview text. Verify every matched file against the full revision it was matched on, in every output mode.
- Validate grep patterns and flags with V8 at tool entry; resolve case overrides once into `GrepQuery.flags` (`src/core/search.ts`). Native `RegExp` in `src/core/search.ts` decides every grep match on the LF view; rg only lists candidates and never decides a match.
- Translate a non-multiline query only in `src/pi/rg-regex.ts`, into rg patterns that list every line the query matches: keep a construct only where both engines give it the same meaning over the original line bytes (CRLF, malformed UTF-8, surrogate halves included), and otherwise widen it; never narrow. Workers re-check exactly those lines. A multiline query, or a pattern rg rejects, uses the file prefilter.
- Resolve bounded `v` class candidates in `src/pi/rg-regex.ts` using the running V8's membership semantics: intersections may enumerate either finite operand, subtractions only the left, and unions require every operand. Keep original scoped case flags for membership even when translating a backreference; apply repetition case widening afterward through the existing byte translator. Leave unbounded or oversized classes widened instead of introducing separate Unicode tables.
- Derive candidate literals in `src/core/search-analysis.ts`: every match must contain one, and its text must appear unchanged in the original bytes, so cut literals at characters whose bytes can differ from the LF view. Derive case equivalence from the engine (`src/core/case-fold.ts`). When a construct is not understood, widen the candidates to every file; never narrow them by approximation.
- Keep grep matching in the bounded, cancellable worker pool of `src/pi/grep-search.ts`; use `scanTextFile` for guarded source reads and the existing grep snapshot/output pipeline. Document file and worker budgets and physical-line semantics in README.
- Render reports through `src/pi/render.ts` from structured `details.report`; decode Pi's text-only argument rejections with the current wire schema. Use `src/pi/diagnostic-buffer.ts` for bounded stderr and search diagnostics.
- 行 hash 是可碰撞的位置相关 checksum。恢复候选由调用方重新提交验证；range 验证边界见 README。
- `edit/replace` 提交绑定实际读取字节的 revision。工具结果使用 `publishedRevision`；Action Fusion 以 mutation 返回的 `publishedRevision` 为 freshness 基线。
- Return successful mutations as one report without anchor rows; keep anchors in read/grep output and edit failure diagnostics. Keep diffs in mutation details for the TUI.
- 保留提交阶段与 `NOT_PUBLISHED` / `PUBLISHED` / `UNKNOWN` 状态，分别报告文件发布结果和后续命令结果。
- Action Fusion 通过 `ctx.executeTool("bash", ...)` 调用会话中的 Bash，遵循 override、`tool_call` 和 `tool_result` 钩子；以最终会话结果判定命令状态并向父结果传递 `terminate`，命令失败不回滚已发布文件。
- 配置字段为 `hashlineEdit`。项目 `.pi/settings.json` 的该字段整体替换全局字段；每个设置项单独校验，缺失或非法时回退默认值。类型、范围和默认值只在 `src/pi/config.ts` 的 schema 中定义。全局路径通过 `getAgentDir()` 获取。
- 工具在注册时接收解析后的配置并在生命周期内保持不变；修改配置需要 reload。
- Define output sizing in `src/pi/budgets.ts` and cache it per extension in `src/pi/model-budgets.ts`; derive byte allowances only from the selected model's declared capacity, never remaining context. Share the provider with preparation, capture an immutable snapshot before each execution's asynchronous work, and keep explicit `read.maxKiB` as the read cap; model-derived content budgets share the `MAX_CONTENT_KIB` ceiling the explicit range also uses. Bound worker failures only in the receiving tool.

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
- Validate text-only reports with the closed wire schemas in `report-schema.ts`; require code-specific facts. Serialize only report facts. Preserve underlying cause chains and aggregate branches; skip cyclic and repeated native errors. Derive Fusion progress from `ACTION_FUSION_PROGRESS_SCHEMA` and validate persisted command cards in `fusion-card.ts` before restoring state.
- Keep Pi argument preparation and original-schema acceptance in `argument-validation.ts`; observe prepared failures without reimplementing coercion or optional-null rules. Keep failure-only schema projection and structured aggregation in `argument-diagnostics.ts`; derive branches, choices, and the explanations of missing, forbidden, and pattern-mismatched fields from the declared schema, suppress only inapplicable or already explained issues, and retain independent fields with bounded native diagnostics.
- Keep the JSON argument-error envelope and its byte budget in `argument-error.ts`; retain exact field paths, omit whole issues or the argument copy with explicit markers, and never truncate serialized JSON. Use the same envelope for preparation failures.
- Keep grep scope error classification in `grep-scope.ts`: only `ENOENT` means `PATH_NOT_FOUND`; preserve other filesystem errors.
- 依赖外部引擎语义的判断交给该引擎本身，不在本地重新实现或近似。

## 测试标准

- 每条测试保护一条可对外说明的契约：README、本文件的行为契约，或一个已发生的 bug。说不出保护什么，就不写。
- Do not use Claude for new model-backed experiments.
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
- Targeted tests: `npm test -- --test-name-pattern "<regex>"`; use the same option with `npm run test:integration`. Keep the npm runner isolation; do not invoke `node --test` directly.
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
