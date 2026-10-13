# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

[English](README.md) · 简体中文

为 [Pi](https://github.com/earendil-works/pi-coding-agent) 提供基于行哈希锚点的文件编辑。模型引用 `read` 或 `grep` 输出中的锚点来修改行，写入前每个锚点都会与当前文件核对。过期或错误的修改会被拒绝，并附带足够的信息让模型自行纠正，而不是悄悄改错行。

## 优势

- **改到模型想改的位置。** 每一行都带一个简短的 `行号#哈希` 锚点。模型看过之后文件如果变了，修改会被拒绝，报告会指出这一行移到了哪里。
- **不靠文本匹配。** 模型不需要原样复述旧文本，空白差异、重复片段和大段代码不再导致修改失败或改错地方。
- **文件字节不走样。** 保留 BOM、CRLF/LF 换行、文件末尾换行和所有未改动的字节；非法 UTF-8 和 NUL 字节在写入前就被拒绝。
- **安全写入。** 先写临时文件，再通过 link 或 rename 原子发布；写入绑定读取时的文件版本，出错时明确告知文件是否已经改动。
- **减少来回。** 修改可以顺带一条后续命令，例如 `npm test`（[Action Fusion](#action-fusion)）；可选的 [`forget`](#forget) 工具能把用完的大段查看结果移出上下文。
- **统一使用 JavaScript 正则。** `grep` 和 `replace` 都采用模型熟悉的 JavaScript 正则语义，同时借助 ripgrep 快速筛选候选文件。
- **输出按模型调整。** 结果大小随所选模型的上下文窗口缩放：小模型不会被撑爆，大模型也不会信息不足。

## 安装

```bash
pi install npm:@criogaid/pi-hashline-edit
```

需要 Pi 0.99.1 或更高版本。扩展只处理本地文件；如果使用远程或自定义存储，把 `hashlineEdit.enabled` 设为 `false` 并重新加载 Pi，即可恢复内置工具。

## 快速上手

Pi 的模型会自动使用这些工具。`read` 返回带锚点的行：

```text
greet.ts · 3 lines
1#ZR63│export function greet() {
2#GFYR│  return "hello";
3#FNSZ│}
```

模型把锚点复制到 `edit` 中：

```json
{
  "path": "greet.ts",
  "edits": [{ "op": "replace", "anchor": "2#GFYR", "body": ["  return \"hello, hashline\";"] }]
}
```

只有第 2 行内容仍然一致时修改才会成功。TUI 显示 diff，模型收到一份简短的 JSON 报告。

## 工具

扩展替换 Pi 的 `read`、`grep`、`edit`、`write`，并新增 `replace` 和可选的 `forget`。

| 工具 | 作用 |
| --- | --- |
| `read` | 显示带锚点的 UTF-8 文本，按模型的输出预算分页。图片和含 NUL 字节的文件交给 Pi 内置的 read。 |
| `grep` | 用 JavaScript 正则或字面文本搜索文件和目录，返回带锚点的匹配行、文件路径或计数；遵守忽略规则。 |
| `edit` | 按锚点替换、插入、删除、复制或移动整行。一次调用中的所有操作基于同一份快照，要么全部生效，要么全部不生效。 |
| `replace` | 在单个文件内批量执行字面或正则替换。每条规则都必须有匹配，匹配区域重叠时整批拒绝。 |
| `write` | 新建文件（`mode: "create"`）或覆盖文件（`mode: "overwrite"`），内容原样写入。 |
| `forget` | 把之前的 `read`/`grep` 结果移出模型上下文，可附一条备注。默认关闭。 |

`edit` 的操作：

| `op` | 效果 |
| --- | --- |
| `replace` / `delete` | 替换或删除一行；配合 `end` 处理闭区间范围。 |
| `insert_before` / `insert_after` | 在锚点前或后插入行。 |
| `prepend` / `append` | 在文件开头或末尾插入行。 |
| `copy` / `move` | 把一段行复制或移动到另一个锚点之前或之后。 |

模型能看到每个工具完整的参数 schema，定义位于 [`src/pi/`](src/pi/) 下的各工具文件。

## 修改被拒绝时

被拒绝的调用不会改动文件。报告会给出错误码、相关字段和一条 `next` 指引。锚点过期时，报告还会给出这一行最可能的新位置、新锚点和附近几行，模型确认后即可重新提交，不必重读整个文件。恢复过程从不自动修改，每次重试都会重新核对。

参数错误按字段逐条报告，说明字段的含义和修正方法，此时还不会碰任何文件。

## Action Fusion

`edit`、`replace`、`write` 可以带一个可选的 `then_run` 命令，在修改成功后立即运行：

```json
{
  "path": "src/foo.ts",
  "replacements": [{ "find": "oldName", "replace": "newName" }],
  "then_run": { "command": "npm test", "timeout": 60 }
}
```

命令通过会话自己的 Bash 工具执行，审批、覆盖和钩子照常生效。只有修改成功且文件仍是刚写入的内容时才会启动。命令失败不会回滚文件。TUI 把修改和命令分成两张卡片显示，设置了超时时会显示实时倒计时。

## Forget

启用 `hashlineEdit.forget` 后，模型可以在用完之后，把较大的 `read` 和 `grep` 结果（2 KiB 及以上，或图片）移出上下文。每个符合条件的结果带一个 `resultId`，模型用这些 id 调用 `forget`，并可附一条需要记住的备注。文件、会话历史和 TUI 都不受影响，重新执行原来的调用即可再次看到内容。

## 配置

在 Pi 的全局设置（`~/.pi/agent/settings.json`）或项目的 `.pi/settings.json` 中添加 `hashlineEdit`：

```json
{
  "hashlineEdit": {
    "enabled": true,
    "actionFusion": true,
    "forget": false,
    "hashLen": 4,
    "shiftRadius": 15,
    "read": { "defaultLimit": 500 },
    "grep": { "defaultLimit": 100, "defaultContext": 0, "regexTimeoutMs": 5000 },
    "replace": { "regexTimeoutMs": 5000 }
  }
}
```

| 设置项 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 注册扩展的工具。 |
| `actionFusion` | `true` | 允许修改类工具使用 `then_run`。 |
| `forget` | `false` | 注册 `forget` 并给符合条件的结果打标签。 |
| `hashLen` | `4` | 锚点哈希长度，2–8。 |
| `shiftRadius` | `15` | 锚点过期时先在附近多少行内查找，再查全文件，0–100；`0` 关闭恢复查找。 |
| `read.defaultLimit` | `500` | 调用未指定时返回的行数。 |
| `read.maxKiB` | 按模型 | read 输出的固定上限，1–4096 KiB。 |
| `grep.defaultLimit` | `100` | 调用未指定时返回的匹配行数。 |
| `grep.defaultContext` | `0` | 每个匹配前后的上下文行数，0–20。 |
| `grep.regexTimeoutMs` / `replace.regexTimeoutMs` | `5000` | 单次正则计算的时限，3000–300000 毫秒。 |

项目中的 `hashlineEdit` 会整体替换全局配置；非法值回退为默认值。修改设置后需重新加载 Pi。以 [配置 schema](src/pi/config.ts) 为准。

## 限制

- 锚点是简短的校验和：能发现内容变化和行位移，但可能碰撞，也不能证明模型真的读过这一行。
- 只编辑 UTF-8 文本，不支持 UTF-16 和旧式代码页。
- 版本检查能发现大多数并发修改，但没有跨进程锁，也没有多文件事务。
- 覆盖写入时保留符号链接、改写其指向的文件；FIFO 等非普通文件和有多个硬链接的文件不会被覆盖。

## 开发

| 命令 | 检查内容 |
| --- | --- |
| `npm run format:check` | 格式。 |
| `npm run typecheck` | 源码、测试和基准测试的类型。 |
| `npm test` | 核心与工具测试。 |
| `npm run test:integration` | 真实 ripgrep、大文件、已安装包和真实 Pi 会话。 |
| `npm run test:all` | 两套测试，与 CI 一致。 |
| `npm run test:cartesian` | 耗时较长的笛卡尔积正则矩阵；修改正则翻译或预筛后运行。 |

报告字段和错误码定义在 [`report-schema.ts`](src/pi/report-schema.ts)。模块职责见 [`src/core/AGENTS.md`](src/core/AGENTS.md) 与 [`src/pi/AGENTS.md`](src/pi/AGENTS.md)。[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 列出了借鉴的技术和测试用例。
