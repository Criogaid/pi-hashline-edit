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
- 文本编辑保留 BOM、行尾和未触及字节。无效 UTF-8、NUL 或非法单行正文应在写入前拒绝。`read` 的二进制/图片分支委托原生工具。
- 行 hash 是可碰撞的位置相关 checksum。恢复候选由调用方重新提交验证；range 验证边界见 README。
- `edit/replace` 提交绑定实际读取字节的 revision。`revision` 是 `publishedRevision` 的兼容别名；Action Fusion 以 mutation 返回的 `publishedRevision` 为 freshness 基线。
- 保留提交阶段与 `NOT_PUBLISHED` / `PUBLISHED` / `UNKNOWN` 状态，分别报告文件发布结果和后续命令结果。
- 配置字段为 `hashlineEdit`。项目 `.pi/settings.json` 的该字段整体替换全局字段，缺项回退默认值。全局路径通过 `getAgentDir()` 获取。

## 验证

按改动影响选择检查：

- 类型：`npm run typecheck`。
- 单文件测试：`node --test src/pi/execute.test.ts`（按需替换路径）。
- core 和 pi 测试：`npm test`。
- 真实后端集成：`npm run test:integration`；组合运行用 `npm run test:all`。

本地类型检查和测试可直接运行，修复本次改动导致的失败后重跑受影响检查。报告实际结果及平台跳过项。

独立测试进程读取磁盘源码；通过当前 Pi 会话验证已加载的扩展行为时，需要用户 `/reload` 或重启。等待重载期间继续完成独立检查。纯文档改动核对事实、路径和 diff 即可。

## 提交与发布

- Commit scope 使用 `pi-hashline-edit`。
- AI 辅助提交附加 `Co-Authored-By: <PI_MODEL 的值> <noreply@pi.dev>`。提交前读取 `PI_MODEL`；环境未提供时说明缺失。
- push、版本、tag 和发布动作按用户授权及实际 workflow 执行。
