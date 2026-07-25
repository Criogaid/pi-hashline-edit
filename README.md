# @d3ara1n/pi-hashline-edit

> Hashline-style file editing for [pi](https://github.com/earendil-works/pi-coding-agent) — line-anchored edits verified by content hash, replacing `oldText`/`newText` matching.

用「行级内容 hash + 行号」双重锚替代 pi 内置的 `oldText`/`newText` 精确匹配编辑。模型指出要改的行（带 hash 校验），而不是重打要改的代码——从根上消除 string-not-found 死循环与空白战争。

## 设计要点

- **行级 hash + 行号双重锚**：`read` 每行带短 hash（`3#aF3│code`），`edit` 引用 `行号#hash`。行号给人读，hash 给机器校验——天然抗行号漂移。
- **context-aware hash**：每行 hash 把上下两行一起算，使内容相同的行（空行、`}`）因邻居不同而 hash 不同，文件内碰撞接近 0。
- **严格核心 + 可插拔容错**：核心 `parse → apply` 零猜测、失败快；容错（旧格式归一化、漂移重定位、块解析）做成独立开关的中间件。
- **不兼容旧格式**：override 内置 `edit`/`read`。edit 只接受 hashline `input`；模型误发 `oldText`/`newText` 会收到明确错误（而非静默降级到旧方案）——让开发者知道 hashline 是否真在用。容错仅限不影响结果的格式归一化。

> **状态**：Phase 1 纯核心库（`src/core/`）已完成，可独立测试。pi 接入层（`src/pi/`）开发中。

## 协议速览

`read` 输出（每行带锚）：

```
src/foo.ts · 6 lines
   1#aF3│import { compute } from "./util"
   2#7Qk│
   3#mP0│export function foo(x: number) {
   4#kLp│  if (x < 0) return 0
   5#xY9│  return compute(x)
   6#b2H│}
```

`edit` 的 `input`：path 在工具参数里，input 只含 ops（无需 `file:` 头，工具自动注入）

```
replace 4#kLp:
+  if (x < 0) throw new Error("neg")

insert_after 6#b2H:
+
+export const bar = foo
```

## Installation

```bash
pi install npm:@d3ara1n/pi-hashline-edit
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-hashline-edit"
  ]
}
```

## Dependencies

- 无额外 `@d3ara1n/pi-*` 依赖；peer `@earendil-works/pi-coding-agent` 随 pi 附带（框架级，按惯例不列）。
