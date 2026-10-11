# dsh-notes-context

> 给 DeepSeek Harness 带来 omp（Oh My Pi）的 **笔记式上下文压缩**：
> 用「模型自己维护的持久笔记本」取代 LLM 摘要式压缩。
> **跨上下文窗口的边界本身零模型调用。**

[English](README.en.md) | 简体中文

---

## 它解决什么

DSH 默认压缩在上下文将满时做一次**额外的 LLM 调用**，把旧历史摘要掉。代价有三：等你最需要干活时的**延迟**、取决于模型发挥的**不确定性**、以及**原文再也读不回来**。

这个插件换一条路：**不摘要，改记笔记**。

| | 默认压缩 | 本插件 |
|---|---|---|
| 边界处是否调模型 | 是（一次完整摘要请求） | **否**（写入静态模板） |
| 边界是否可预测 | 否 | 是（纯本地、确定性） |
| 旧历史还能读原文吗 | 不能 | **能**，按 seq 精确回读 |
| 谁决定什么重要 | 摘要模型 | 干活的那个模型自己 |

## 机制

**笔记本（`context_notes`）** — 模型主动把任务状态、决策、改过的文件、阻塞项、下一步写进一本持久笔记本。

```
context_notes                    → 读取
context_notes { text: "..." }    → 整体替换（不是追加）
context_notes { text: "" }       → 清空
```

上限 16 KiB（UTF-8 字节），超限**在写入前**就失败，不会写半截。

**提醒（每窗口一次）** — 上下文接近触发点时，插件插入一条模型可见的提醒，让模型赶在细节掉出窗口前更新笔记本。提醒**不是必需的**：模型完全无视它，压缩照样发生。它买的是**保真度**，不是省开销。

**窗口滚动（零模型调用）** — 到触发点时，插件复用 DSH 内置压缩的压力策略与保留策略，**只替换摘要文本**为一段静态模板 + 当前笔记本全文。`summarize()` 永不调用模型。

**原文回读（`context_history`）** — 滚动只是**遮蔽**被替换的历史，不删除（日志是 append-only 的）。模型随时可按稳定 seq 回读：

```
context_history                                 → 全量索引
context_history { from: 120, to: 200 }          → 精确区间
context_history { from: 0, to: 50, raw: true }  → 原文
```

## 配置

只讲最常用的四个。全部字段见设置页，推导过程见 [内部机制](docs/INTERNALS.md)。

| 字段 | 默认 | 作用 |
|---|---|---|
| `thresholdTokens` | `-1` | **到多少 token 自动压缩**。绝对值优先，填 `450000` 就是 450K，换模型也一样。`-1` 表示改用比例 `thresholdRatio` |
| `keepRecentTokens` | `20000` | **压缩后保留多少原文**，绝对值。实际会多于此数（裁剪按整条消息做） |
| `reserveTokens` | 留空 | 触发点下方留出的余量。留空 = 窗口的 15%，不低于 16384 |
| `reminderEnabled` | `true` | 是否注入提醒 |

> **提醒位置由公式推导，不可配。** 它与触发点绑定：
> `lead = min(32000, max(8192, floor(触发点 × 0.125)))`。
> 所以 `thresholdTokens: 450000` 时，提醒落在 **418,000**（比触发点早 32,000）。想挪它，只能挪触发点。

生效时机：**改完立刻生效**（设置页或配置文件都行）。
例外：`rolloverText`、`notebookSummaryMaxChars` 和两个 `static*` 标记要**下一次窗口滚动**才体现——它们只在写边界时被读取。

```yaml
- id: notes-context
  config:
    thresholdTokens: 450000
    keepRecentTokens: 20000
```

## 安装

```sh
dsh plugin --profile <你的 profile> add ./packages/dsh-notes-context
dsh --profile <你的 profile> --dump-config   # 确认两层都生效
```

组合包自带两行 patch：停用 `compaction-basic`，挂载本包。

## 诚实的限制

- **笔记本的质量和及时性完全是模型的责任。** 插件不会自动补写、不会替你总结。模型没写或写得含糊，跨窗口后就是真丢了细节——虽然还能用 `context_history` 从原文捞。
- **笔记本每写一次就是一条留在上下文里的消息。** 频繁重写会让上下文变大。
- **边界零开销 ≠ 整个过程零开销。** 写笔记本本身是一次工具调用，成本只是从边界前移了。
- **DSH 自身的压缩配置改不了、也看不到**，只能改配置文件并重启 dsh（原因见 [内部机制](docs/INTERNALS.md)）。
- 子代理等受限工具集的会话如果拿不到 `context_notes`，会自动退化成「无笔记本的滚动」。

## 开发

```sh
cd packages/dsh-notes-context
npm run typecheck
npm run build
npm test
```

## 许可

MIT
