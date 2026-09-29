# Pi Hashline Edit

pi 扩展 `@criogaid/pi-hashline-edit`，注册入口为 `src/index.ts`。

## 按任务定位

- `src/core/`：行拆分、checksum、文本解码与纯函数编辑 applicator。
- `src/pi/`：工具注册、配置、渲染、文件提交和 Action Fusion。
- `src/integration/`：真实后端集成测试。
- 改工具参数、用户可见行为或配置时，核对 `README.md` 中对应契约。
- 改 pi API、生命周期或 TUI 集成时，查看当前安装版本的 pi 文档和类型声明。
- 涉及发布时，核对 `.github/workflows/publish.yml` 与 `package.json`。

## 行为契约

- 保留结构化 JSON edits、纯函数 applicator 和批次校验；文件修改复用 `withFileMutationQueue` 与现有提交层。
- 文本编辑保留 BOM、行尾和未触及字节。无效 UTF-8、NUL 或非法单行正文应在写入前拒绝。`read` 用 Pi 的图片识别接口将受支持图片交给原生工具；含 NUL 文件也委托原生 read，其余无效 UTF-8 拒绝。
- `read/grep/edit/replace` 共用 CRLF→LF 的逻辑文本视图；独立 CR 和源码中的字面转义仍是内容。修改需映回原始偏移并保留未触及字节；`write` 则精确使用调用方提供的完整内容及行尾。
- 行 hash 是可碰撞的位置相关 checksum。恢复候选由调用方重新提交验证；range 验证边界见 README。
- `edit/replace` 提交绑定实际读取字节的 revision。工具结果使用 `publishedRevision`；Action Fusion 以 mutation 返回的 `publishedRevision` 为 freshness 基线。
- 保留提交阶段与 `NOT_PUBLISHED` / `PUBLISHED` / `UNKNOWN` 状态，分别报告文件发布结果和后续命令结果。
- 配置字段为 `hashlineEdit`。项目 `.pi/settings.json` 的该字段整体替换全局字段，缺项回退默认值。全局路径通过 `getAgentDir()` 获取。

## 编码约定

每条标准只保留一个定义点。新增代码先找现有定义，不要在调用处重写。

- 参数校验只在工具边界做一次：TypeBox schema 加 `parseToolInput`。下游（mutation runner、Action Fusion、applicator、worker）信任已校验的输入，不重复校验，也不做兼容转换。schema 表达不了的语义检查（安全整数行号、正则能否编译、路径是否存在）放在边界之后的第一步。
- 共享约束的唯一来源：
  - 整数范围：`src/pi/schema.ts`
  - 哈希长度上下限：`src/core/hash.ts`
  - 错误码文本：`src/core/text.ts`
  - 面向模型的输出字节预算：`src/pi/budgets.ts`
- 类型从 schema 推导（`Static<...>`），或只定义一次并在其他地方导入，不要另写一个同构的 interface。
- 输出预算和 README "Output budgets" 一一对应，改其中一边要同步另一边。提示和错误文本里的数值（如 `16 KiB`）由常量生成（`formatKiB`），不要写死。
- 修改类工具走 `src/pi/mutation-runner.ts`：用 `executeMutation` 串起校验、路径、队列和 Action Fusion；读-改-写用 `runTextMutation`，工具只提供 `TextChange`。`then_run` 字段用 `withThenRunSchema` 添加。
- 把捕获到的错误转成文本统一用 `errorMessage`（`src/pi/error-text.ts`）。
- 正则方言不做转换。grep 用 ripgrep 的 Rust regex：凡是需要理解 pattern 的判断（是否为正则、smart-case、语法是否合法）都交给 rg，不在 JS 里重新解析或匹配 pattern。replace 用 JavaScript `RegExp`。两者的参数说明都要写明各自的方言。
- 文案里引用容易混淆的 Unicode 字符（如 U+212A 与 ASCII `K`）时写明码位，写入后按码位核对。

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
