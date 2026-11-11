# @criogaid/pi-hashline-edit

[![CI](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-hashline-edit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@criogaid/pi-hashline-edit)](https://www.npmjs.com/package/@criogaid/pi-hashline-edit)

[English](README.md) · 简体中文

为 [Pi](https://github.com/earendil-works/pi-coding-agent) 提供基于行哈希锚点的文件编辑。模型引用 `read` 或 `grep` 输出中的锚点来修改行，写入前每个锚点都会与当前文件核对。过期或错误的修改会被拒绝，并附带足够的信息让模型自行纠正，而不是悄悄改错行。

## 优势

- **改到模型想改的位置。** 每一行都带一个简短的 `行号#哈希` 锚点。模型看过之后文件如果变了，修改会被拒绝，报告会指出这一行移到了哪里。
- **不靠文本匹配。** 模型不需要原样复述旧文本，空白差异、重复片段和大段代码不再导致修改失败或改错地方。
- **文件字节不走样。** 保留 BOM、CRLF/LF 换行、文件末尾换行和所有未改动的字节；非法 UTF-8 和 NUL 字节在写入前就被拒绝。
- **安全写入。** 先写临时文件，再通过 link 或 rename 原子发布；读改写调用绑定实际读取的字节，出错时明确告知文件是否已经发布。
- **减少来回。** 修改可以顺带一条后续命令，例如 `npm test`（[Action Fusion](#action-fusion)）。
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
  "steps": [{ "action": "replace", "anchor": "2#GFYR", "lines": ["  return \"hello, hashline\";"] }]
}
```

只有第 2 行内容仍然一致时修改才会成功。TUI 显示 diff，模型收到一份简短的 JSON 报告。

## 工具

扩展替换 Pi 的 `read`、`grep`、`edit`、`write`，并新增 `replace`。

| 工具 | 作用 |
| --- | --- |
| `read` | 显示带锚点的 UTF-8 文本，按模型的输出预算分页。图片和含 NUL 字节的文件交给 Pi 内置的 read。 |
| `grep` | 用 JavaScript 正则或字面文本搜索文件和目录，按遍历顺序返回带锚点的匹配行、文件路径或计数，设了 limit 时保留该顺序下的前若干条匹配。搜索目录时遵守忽略规则，并跳过 `.git` 和链接目录，在 `path` 指定的目录之下也是如此；在 `path` 中直接指定被忽略的文件或这些目录本身才会搜索。 |
| `edit` | 按锚点替换、插入或删除整行。一次调用中的所有操作基于同一份快照，要么全部生效，要么全部不生效。 |
| `replace` | 在单个文件内批量执行字面或正则替换。每条规则都必须有匹配，匹配区域重叠时整批拒绝。 |
| `write` | 新建文件（`mode: "create"`）或覆盖文件（`mode: "overwrite"`），内容原样写入，缺失的父目录会一并创建。 |

文件路径支持相对路径、绝对路径、`~`、可选的前导 `@` 和 `file://` URL。Windows 还支持 `/c/work/file.txt`、`/mnt/c/work/file.txt`、`/cygdrive/c/work/file.txt` 等 shell 盘符路径。相对路径以工作区目录为基准解析。

路径输入会把 U+202F 等部分 Unicode 空格归一化为普通空格。要精确读取文件名中含有 Unicode 空格的文件，请传入经过百分号编码的文件 URL，例如 `file:///home/me/space%E2%80%AFname.txt` 对应含有 U+202F 的文件名。`read` 和 `grep` 返回的路径可以直接传回工具；请保留返回的写法，包括 URL 转义。`read` 将图片和含 NUL 字节的文件交给 Pi 时，也使用相同的路径语法。

Grep 按传入顺序访问各个搜索路径，在每个根路径内采用 ripgrep 的有序目录遍历。重复候选路径只在第一次出现时搜索。这不是对所有文件完整路径做全局字典序排序。

Grep 用原生 JavaScript 正则匹配 LF 视图。不设 `multiline` 时逐物理行搜索；设为 true 时搜索整个文件，返回匹配涉及的每一物理行。上下文行不计入 `limit`。content 输出会重读匹配文件，略过版本已变的文件；`files` 和 `count` 直接报告搜索时的快照，不做第二次读取。扫描不完整时，报告会给出诊断或扫描上限。

`replace` 在相同的 LF 视图上匹配，开头的 BOM 也参与匹配。组装文件时，原 BOM 保持在字节零处，即使匹配包含它或在它前面插入内容。替换包含文件头的匹配时，替换文本开头复制的 BOM 复用原文件头；显式插入或位于正文中的 U+FEFF 字符仍作为内容保留。若需连同 BOM 一起替换完整文件内容，使用 `write`。

grep 卡片原样显示返回的文件路径和计数行。只有 `content` 模式会格式化匹配行，隐藏锚点哈希并折叠共有缩进。

`edit` 调用先给出定位信息：`path`、`steps`，再是可选的 `then_run`。每个操作先给出动作和范围，再给出替换内容：`action`、`anchor`、可选的 `end`，最后是 `lines`。参数流式输出时，TUI 可以先显示文件和目标范围。
`edit` 的操作：

| `action` | 效果 |
| --- | --- |
| `replace` / `delete` | 替换或删除一行；配合 `end` 处理闭区间范围。 |
| `insert_before` / `insert_after` | 在锚点前或后插入行。 |
| `prepend` / `append` | 在文件开头或末尾插入行。 |

一次调用最多 [64 个操作](src/pi/edit-tool.ts)。一次调用中的范围不能重叠，相邻两行之间的每个位置最多一次插入。位于替换或删除区间起点的插入放在该区间之前。

在提供方支持时，所有工具都请求约束采样（Pi 的 `constrainedSampling`，即 strict JSON schema），模型因此无法写出 schema 未声明的字段或取值，也无法超出 edit 的操作数上限。这时调用中没用到的可选字段都写 `null`，edit 每个操作里其 `action` 用不到的字段也一样。出于同一原因，grep 的 `pattern`、`path` 和 `glob` 只接受数组；在其他提供方上，Pi 会把单个字符串包成数组。

模型能看到每个工具完整的参数 schema，定义位于 [`src/pi/`](src/pi/) 下的各工具文件。

范围操作核对给出的 `anchor`、`end`，不逐行验证区间内部的内容。调用前其他位置的变化不会使未改变的锚点失效；发布前会复核修改操作实际读取的字节，检测到变化时拒绝发布。

## 修改被拒绝时

参数和锚点校验失败时不会改动文件。报告会给出错误码和相关字段；参数问题按字段给出 `fix`，锚点失败给出一条 `next` 恢复指引。锚点过期时，报告还会给出这一行最可能的新位置、新锚点和附近几行，模型确认后即可重新提交，不必重读整个文件。恢复过程从不自动修改，每次重试都会重新核对。

发布期间或发布后的失败会明确标记 `NOT_PUBLISHED`、`PUBLISHED` 或 `UNKNOWN`。重试前应遵循报告的 `next`：发布后的错误可能意味着所需修改已经写入磁盘。

参数错误（包括反向范围）按字段逐条报告，说明字段的含义和修正方法，此时还不会碰任何文件。

## Action Fusion

`edit`、`replace`、`write` 可以带一个可选的 `then_run` 命令，在修改成功后立即运行：

```json
{
  "path": "src/foo.ts",
  "replacements": [{ "find": "oldName", "literal": true, "replace": "newName" }],
  "then_run": { "command": "npm test", "timeout": 60 }
}
```

命令通过会话自己的 Bash 工具执行，审批、覆盖和钩子照常生效。只有修改成功且文件仍是刚写入的内容时才会启动。命令失败不会回滚文件。TUI 把修改和命令分成两张卡片显示，设置了超时时会显示实时倒计时。

命令卡片使用 Pi 原生工具组件处理鼠标点击和全局展开快捷键，输出更新或屏幕重绘时保留各自的展开状态。内置 Bash 渲染器直接显示命令的原始内容和 details，并将它们保存到会话中以供恢复；当前支持的 Pi API 无法取得其他扩展自定义的 Bash 渲染器。

## 配置

在 Pi 的全局设置（`~/.pi/agent/settings.json`）或项目的 `.pi/settings.json` 中添加 `hashlineEdit`：

```json
{
  "hashlineEdit": {
    "enabled": true,
    "actionFusion": true,
    "hashLen": 4,
    "shiftRadius": 15,
    "read": { "defaultLimit": 2000 },
    "grep": { "defaultLimit": 100, "defaultContext": 0, "regexTimeoutMs": 5000 },
    "replace": { "regexTimeoutMs": 5000 }
  }
}
```

| 设置项 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 注册扩展的工具。 |
| `actionFusion` | `true` | 允许修改类工具使用 `then_run`。 |
| `hashLen` | `4` | 锚点哈希长度，2–8。 |
| `shiftRadius` | `15` | 锚点过期时先在附近多少行内查找，再查全文件，0–100；`0` 关闭恢复查找。 |
| `read.defaultLimit` | `2000` | 调用未指定时返回的行数，与 Pi 内置 read 一致。 |
| `read.maxKiB` | 按模型 | read 输出的固定上限，1–4096 KiB。 |
| `grep.defaultLimit` | `100` | 调用未指定时返回的匹配行数。 |
| `grep.defaultContext` | `0` | 每个匹配前后的上下文行数，0–20。 |
| `grep.regexTimeoutMs` / `replace.regexTimeoutMs` | `5000` | 单次正则计算的时限，3000–300000 毫秒。 |

项目中的 `hashlineEdit` 会整体替换全局配置；非法值回退为默认值。修改设置后需重新加载 Pi。以 [配置 schema](src/pi/config.ts) 为准。

## 输出预算

输出预算根据所选模型声明的上下文容量计算，不使用剩余上下文。容量已知时，带锚点的 read 行和 grep 载荷各获得每上下文 token 一字节的预算，最高 4 MiB。诊断块获得其四分之一，至少 512 字节；自由文本字段获得诊断块预算的四分之一，至少 128 字节。Grep 预览每四字节字段预算保留一个 UTF-16 单元。定义和回退值位于 [`budgets.ts`](src/pi/budgets.ts)。

模型容量未知或非法时，默认上限为 read 行 256 KiB、grep 载荷 50 KiB、每个诊断块 16 KiB、每个自由文本字段 4 KiB、每条 grep 预览 500 个 UTF-16 单元。显式设置 `read.maxKiB` 只覆盖 read 上限。每次执行使用开始时取得的预算快照。

Read 因默认行数或字节预算截断窗口时会报告 `nextOffset`；只有调用方指定的 `limit` 生效时不额外报告 `nextOffset`。首行放不下时报告 `lineTooLong`，其值为字节上限。Grep 分别报告载荷和行预览的截断，非法 UTF-8 的普通预览不带编辑锚点。

grep 载荷被截断时，先用 `context: 0` 重试，再进一步缩小搜索范围。依据部分预览重写前需检查完整行：`invalidUtf8` 列出的路径使用 Bash，有效 UTF-8 使用 `read`。

## 限制

- 锚点是简短的校验和：能发现内容变化和行位移，但可能碰撞，也不能证明模型真的读过这一行。
- 只编辑 UTF-8 文本，不支持 UTF-16 和旧式代码页。
- 版本检查能发现大多数并发修改，但没有跨进程锁，也没有多文件事务。
- 覆盖写入时保留符号链接、改写其指向的文件；FIFO 等非普通文件和有多个硬链接的文件不会被覆盖。
- Grep 的[搜索限制](src/pi/grep-search.ts)允许 multiline 文件最多 64 MiB、单条物理行最多 64 × 1024² 个 UTF-16 单元。最多使用四个匹配 worker，每个 worker 的 V8 老生代堆上限为 512 MiB；单次正则计算受配置中的超时约束。
- 候选发现回退到作用域内所有文件时，累计排入队列的文件大小达到 [256 MiB 扫描预算](src/pi/grep-candidates.ts) 后停止继续加入文件；最后一个文件可以使总量超过该阈值。报告会指出预算是否阻止了后续文件的扫描。Ripgrep 协议记录的[上限为 16 MiB](src/pi/rg-process.ts)，其 stderr 最多保留 64 KiB（开头和结尾）。候选分析不支持或超限时会扩大候选范围，最终匹配仍由 JavaScript 决定。

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
