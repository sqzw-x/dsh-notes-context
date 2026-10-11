# dsh-notes-context

> 给 DeepSeek Harness 带来 omp（Oh My Pi）的 **notes-backed context windows**：
> 用「模型自己维护的持久笔记本」取代 LLM 摘要式压缩。
> **跨上下文窗口的边界本身零模型调用。**

[English](README.en.md) | 简体中文

---

## 它解决什么

DSH 默认的压缩（`@deepseek-ai/dsh-compaction-basic`）在上下文将满时做一次**额外的 LLM 调用**，
把旧历史摘要成一段文字，然后用它替换掉被压缩的那段历史。代价是三重的：

1. **延迟**——压缩发生在你最需要继续干活的时候，而且必须等那次摘要调用返回；
2. **不确定性**——摘要质量取决于模型发挥，可能丢掉你正需要的细节；
3. **有损**——被摘要掉的内容，模型之后再也看不到原文了。

这个插件换成另一条路：**不摘要，改记笔记**。

| | 默认压缩 | 本插件 |
|---|---|---|
| 边界处是否调模型 | 是（一次完整摘要请求） | **否**（写入静态模板文本） |
| 边界是可预测的吗 | 否（取决于模型输出） | 是（纯本地、确定性） |
| 旧历史还能读原文吗 | 不能，只剩摘要 | **能**，`context_history` 按 seq 精确回读 |
| 谁决定什么信息重要 | 摘要模型 | 干活的那个模型自己 |

## 机制：三件事

### 1. 笔记本（`context_notes` 工具）

模型在干活过程中**主动**把「任务状态、已定决策、改过的文件、证据、阻塞项、下一步」写进一本持久笔记本：

```
context_notes                      → 读取当前笔记本
context_notes { text: "..." }      → 整体替换（不是追加）
context_notes { text: "" }         → 清空
```

- 上限 **16 KiB**（UTF-8 字节，超限**在写入前**就失败，不会写半截）；
- 每次写入是**整体替换**，所以模型倾向于「读一次 → 改 → 写回」，而不是无限追加；
- 投递顺序是安全的：修订版本作为**延迟上下文**随工具结果一起送达，
  因此它在工具结果**之后**进入上下文，绝不会打断 provider 要求的
  `assistant(tool-call) → tool(result)` 相邻关系。

### 2. 阈值提醒（每窗口一次）

上下文进入阈值下方的预热带时，插件在最近的 step 边界插入一条**模型可见、每窗口最多一次**的提醒：

```xml
<context-window-reminder>
The current context window is nearing its rollover threshold. Before important details
fall out of the live tail, use context_notes to save a concise durable notebook: current
task state, decisions, changed files, evidence, blockers, and exact next steps. Keep the
notebook a compact index with one line per item, no copied logs or file bodies, and replace
stale entries instead of appending so it stays well under the configured cap. Do not request
a new window until the notebook is current.
</context-window-reminder>
```

预热带是 `[threshold − lead, threshold)`，`lead = clamp(threshold × 0.125, 8192, 32000)`。
跨过阈值后不再提醒——那时直接滚动窗口。去重键是**分支上最后一个滚动边界**，所以是每窗口一次，
不是每轮一次。

> 注意：**提醒不是必需的**。即使模型完全无视它、一个字都没写，边界照样会提交。
> 提醒买的是**保真度**，不是省开销。

### 3. 零 LLM 调用的窗口滚动

窗口滚动时，本插件的引擎子类化 DSH 的基础压缩后端（复用它的压力策略、保留策略、
工具调用配对与加锁），**只替换摘要文本**：

```xml
<context-window-rollover>
The earlier raw transcript remains canonical and recoverable at context_history.
Continue from the persistent notebook, the retained recent tail, and the latest user request,
which is retained separately when it falls outside the tail.
Earlier task instructions and constraints may still require recovery from raw history.
Do not assume this boundary is an LLM summary; use the notebook and raw-history reads when
prior details are needed.
</context-window-rollover>
```

紧接着附上**当前笔记本全文**（逐字，不再二次加工）。设计上 `summarize()` **永不调用 `ctx.llm`**。

### 附带：原始历史回读（`context_history` 工具）

滚动窗口会**遮蔽（shadow）**被替换的历史节点，但**不删除**它们——日志是 append-only 的。
所以模型随时可以按稳定 seq 回读原始记录：

```
context_history                          → 全量索引（seq / 类型 / 一行摘要）
context_history { from: 120, to: 200 }   → 精确区间
context_history { from: 0, to: 50, raw: true }  → 原文
```

滚动边界（`compaction/start` / `summary` / `end`、以及带 checkpoint source 的替换消息）
会在输出里显式标出来，模型能看见窗口是在哪里滚动的。

## 安装

```sh
dsh plugin --profile <你的 profile> add ./packages/dsh-notes-context
dsh --profile <你的 profile> --dump-config   # 确认两层都生效
```

组合包会自带两行 patch：停用 `compaction-basic`，挂载本包。

## 阈值是怎么算出来的

上面几节反复出现「阈值」「提前量」「保留预算」，这一节把它们逐个算给你看。
读配置之前先看这节，会省很多猜测。**每个符号都先说明它是什么、从哪来、算出来干什么**，
不丢一个变量名了事。

> **只想知道怎么设？** 用 `thresholdTokens` 给绝对值就够，不用算：
> `thresholdTokens: 450000` → 450K 压缩、418K 提醒、保留 20000。
> 下面这一节是推导过程，用于理解默认值和排查意外。

### 输入量（不来自配置）

| 符号 | 含义 | 从哪来 |
|---|---|---|
| `contextWindow` | **模型声明的上下文总容量**，输入与输出共用这一个窗口 | `ctx.llm.resolveModelInfo(provider, model)` 返回的 `context.contextWindow`，由适配器声明 |
| `reservedCompletionTokens` | **为本次回复预留的输出 token**，这段不能拿来放输入 | `session.requestHeader().config.maxTokens` → 取不到则 `info.defaultMaxTokens` → 再取不到则 `0` |

`contextWindow` 是**模型**的属性，不是配置项——换一个模型，下面所有数都会变。

### 第一步：算出两级「还能装多少」

| 符号 | 算式 | 含义 |
|---|---|---|
| `M` | `contextWindow − reservedCompletionTokens` | **扣掉输出预留后，真正能放对话内容的量**。窗口是输入输出共享的，输出那部分必须先让出来 |
| `B` | `M − headroomTokens` | **再扣掉固定预留空间后，允许对话涨到的上限**。压缩不能等窗口真满了才做，得留余量 |

`headroomTokens` 的官方定义是 *"additional pressure headroom beyond the routed output reservation"*
——**在输出预留之外，额外再扣掉的一段固定 token 保留空间**（默认 65536）。它有两个作用：

1. 让阈值**低于**物理容量上限，于是压缩有提前量；
2. `maxTokens` 不显式设置时**继承它的值**（`dsh-compaction-basic/lib/index.js:64`）。

### 第二步：算出阈值——两道上限取小

```
thresholdTokens = floor( min( contextWindow × thresholdRatio,  B ) )
                            └───────── 上限一 ─────────┘     └上限二┘
```

| 上限 | 算式 | 含义 |
|---|---|---|
| 上限一：窗口比例 | `contextWindow × thresholdRatio` | **策略偏好**：「窗口用到 80% 就该压了」 |
| 上限二：容量剩余 | `B` | **物理约束**：输出预留和预留空间之后，就剩这么多可用 |

`thresholdTokens` 就是**压力到这个 token 数、dsh 执行一次压缩**的点。两道上限各自代表一种「不许再涨」的理由，
**任一成立就必须压**，所以取小。

### 第三步：算出保留预算

```
retainTokens = retainTokens                    若显式设了绝对值
             = floor( M × retainRatio )        否则
```

**压缩后从最新往回保留多少 token 的原文。** 硬约束：必须 `< thresholdTokens`，否则报错——压完还超阈值就没意义了。

注意**基数**：这里乘的是 `M`（输入预算），而 `thresholdRatio` 乘的是 `contextWindow`。
两者基数不同，**不能直接比大小**。

这个数只是**预算**，实际保留只会更多：裁剪按整条消息做，不能切半条，
所以累加会跨过预算，切点还要再往旧挪以满足 tool-call/tool-result 配对平衡（见 `dsh-compaction-basic/lib/index.js:410-433`）。

### 第四步：算出提醒提前量与触发起止点

```
lead = min( max( round(thresholdTokens × reminderLeadRatio),  reminderLeadMinTokens ),
            max(reminderLeadMinTokens, reminderLeadMaxTokens) )
band = [ max(0, thresholdTokens − lead),  thresholdTokens )
```

| 符号 | 含义 | 怎么读 |
|---|---|---|
| `lead` | **在阈值之前多少 token 就提醒模型该写笔记了** | 三层：① 按比例算 → ② 抬到下限 → ③ 压到上限。最外层的 `max(Min, Max)` 是为了你把下限设得比上限大时不产生倒挂区间 |
| `band` | **提醒实际生效的区间**，半开（左闭右开） | `max(0, …)` 让提前量大于阈值时不出现负数起点 |

半开区间是刻意的：dsh 在 `≥ thresholdTokens` 时压缩（`dsh-compaction-basic/lib/index.js:941`），
提醒在 `< thresholdTokens` 生效，所以**同一步里不可能既提醒又压缩**。

### 一个 1M 窗口的实例（默认配置）

`contextWindow = 1,000,000`，`reservedCompletionTokens = 0`：

| 步 | 量 | 算式 | 值 |
|---|---|---|---|
| 1 | `M` | 1,000,000 − 0 | 1,000,000 |
| 1 | `B` | 1,000,000 − 65,536 | 934,464 |
| 2 | 上限一 | 1,000,000 × 0.8 | 800,000 |
| 2 | 上限二 | = `B` | 934,464 |
| 2 | `thresholdTokens` | min(800,000, 934,464) | **800,000** ← 比例生效 |
| 3 | `retainTokens` | floor(1,000,000 × 0.16) | **160,000** |
| 4 | `lead` | 100,000 → 100,000 → 32,000 | **32,000** ← 上限生效 |
| 4 | `band` | [800,000 − 32,000, 800,000) | **[768,000, 800,000)** |
| — | 单次压缩量 | 800,000 − 160,000 | ~640,000 |

于是事件链是：**768k 起可能提醒 → 模型写笔记 → 800k 压缩（摘要为静态模板，零模型调用）
→ 保留 160k 近期原文 + 笔记本 → 笔记本若被遮蔽随后补发**。窗口每推进 800k 重复一轮，
所以周期是 1.25 个 1M 窗口，窗口内的位置固定。

三个容易算错的地方：

1. **`lead` 是 32k 上限，不是 12.5%**。`800k × 0.125 = 100k` 被 `reminderLeadMaxTokens = 32000` 压住了。
   想让提前量跟着阈值走，必须同时抬高 `reminderLeadMaxTokens`。
2. **两道上限谁生效，取决于 `reservedCompletionTokens`**。预留 ≤ 131,072 时阈值恒为 800k；
   预留到 200,000 时上限二接管，阈值降到 734,464。**输出预留越大，阈值越低。**
3. **`maxTokens` 不是独立配置项**，不设就等于 `headroomTokens`，而它同时影响输出预留和 `B` 两处。

## 配置

### 在设置页里改（推荐）

打开 **设置 → 插件 → 找到 `dsh-notes-context` 组合包 → 它的配置区**，
16 个配置项直接可编辑，**改完立刻生效,不需要重启**。

> **这个页面是官方的,不依赖任何第三方插件。**
> - 席位 `plugins.bundle.config` 由随发行版交付的
>   `@deepseek-ai/dsh-client-ui-plugin-manager` 声明(行 id `ui-plugin-manager`,官方组合里默认启用);
> - 表单控件来自官方组件库 `@deepseek-ai/dsh-client-ui-primitives`,用 `--dsw-*` 设计令牌配色;
> - 本包的浏览器半侧除了 `react` 之外**没有任何运行时依赖**。
>
> 之所以需要自带浏览器半侧,是因为 DSH **没有**"从 schema 自动生成表单"的机制:
> 声明 `.volatile()` 只决定字段的**准入与可写性**(数据面),不负责渲染(UI 面)。
> 没有客户端半侧,那一行在 host 里是活的、可写的,但在界面上完全不出现。

机制：这些字段在 schema 里声明为 `.volatile()`，DSH 的设置服务会把活动 profile 条目里的
volatile 字段自动投影成表单（`dsh-settings` 的 `volatileForm`）。写入走
`loader/volatile-update`，把新值**直接提交进正在运行的 fiber，不重新挂载** ——
所以插件里所有读取都写成 `config.<字段>.get()`，在**用到的当下**取值，
而不是启动时取一次。后者会把值冻住，那就必须重启了。

> ⚠️ 声明 volatile 就**必须**用 `.get()` 读。`.volatile()` 不是标记位，而是一个读写句柄：
> `config.maxNotebookBytes` 是 `{ get, write }`，`Number(...)` 是 `NaN`，
> `JSON.stringify` 得到 `{}`。官方用法见 `dsh-agent-loop`。

### 用 YAML 改

```yaml
- id: notes-context
  config:
    reminderLeadMaxTokens: 100000
    maxNotebookBytes: 32768
```

### 设置页里能改的 16 个字段（全部）

分四组显示,按字段类型用不同控件:

| 控件 | 字段 | 何时生效 |
|---|---|---|
| **开关(Switch)** | `enabled`、`reminderEnabled` | 拨动即写 |
| **多行文本框** | `rolloverText` | 点「保存」 |
| 数字输入框(9 个) | `maxNotebookBytes`、`reminderLeadRatio`、`reminderLeadMinTokens`、`reminderLeadMaxTokens`、`notebookSummaryMaxChars`、`historyDefaultLimit`、`maxHistoryEntries`、`maxHistoryBytes`、`historySummaryMaxChars` | 点「保存」 |
| 单行文本框(4 个) | `staticProvider`、`staticModel`、`summaryTruncationMarker`、`historyBoundaryMarker` | 点「保存」 |

> 两个开关是**拨动即写**,不经过「保存」—— 这是官方约定
> (`dsh-client-ui-settings-general` 的 `Switch.onChange` 直接落盘)。
> 其余字段在表单里暂存,点「保存」一起提交。两者都**不需要重启**。

| 分组 | 字段 | 默认 |
|---|---|---|
| **笔记本** | `enabled` | `true` |
| | `maxNotebookBytes` | `16384` |
| **自动压缩** | `thresholdTokens` | `-1`（跟随比例） |
| | `keepRecentTokens` | `20000` |
| | `reserveTokens` | 留空（= `max(15% × 窗口, 16384)`） |
| **滚动提醒** | `reminderEnabled` | `true` |
| **滚动边界** | `rolloverText` | 见上 |
| | `notebookSummaryMaxChars` | `2048` |
| | `staticProvider` | `dsh-notes-context` |
| | `staticModel` | `static-rollover` |
| **历史回读** | `historyDefaultLimit` | `200` |
| | `maxHistoryEntries` | `500` |
| | `maxHistoryBytes` | `51200` |
| | `historySummaryMaxChars` | `200` |
| | `summaryTruncationMarker` | `…` |
| | `historyBoundaryMarker` | `[ROLLOVER BOUNDARY]` |

### 三个自动压缩字段

对齐 omp 的形态，绝对值优先：

| 字段 | 作用 |
|---|---|
| `thresholdTokens` | **绝对值触发点**。设 `450000` 就到 450K 压缩，窗口由运行时解析后自动折算，换模型也是 450K。填 `-1` 表示改用比例（`thresholdRatio`）。 |
| `keepRecentTokens` | **滚动后保留的原文**，绝对值。默认 20000；取代 DSH 内置压缩的 `retainRatio`/`retainTokens`（你显式设了那两个，则它们优先）。 |
| `reserveTokens` | **触发点下方的预留**。留空 = `max(15% × 窗口, 16384)`；显式设了 DSH 内置压缩的 `headroomTokens` 则它优先。 |

> **提醒位置不可配。** 它由公式推导，与 omp 一致：
> `lead = min(32000, max(8192, floor(触发点 × 0.125)))`。
> 所以 450K 触发 → **418,000 提醒**。想改提醒位置，只能改触发点。

生效时机:绝大多数**下一次调用**就生效;`rolloverText`、`notebookSummaryMaxChars`
和两个 `static*` 标记要**下一次滚动**才体现(它们只在写边界时被读取)。

`enabled` 有一点特殊:关掉之后工具从**下一次调用**起拒服务,但工具条目要重启
才从模型目录里消失 —— 注册是挂载时效果,而 volatile 提交不会重新挂载。

### 哪些不在设置页里，只能改配置文件并重启

> **dsh 自身的压缩配置只能改配置文件（profile 的 YAML），dsh 启动时读一次，改完必须重启 dsh 才生效。**

这些字段**不出现在设置页**，改配置文件是唯一途径：

| | 配置项 | 改的途径 | 生效时机 |
|---|---|---|---|
| **dsh 侧** | `auto` / `thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens` / `maxTokens` / `summarizationProvider` / `summarizationModel` / `compactionRetries` / `maxOverflowRetries` / `modelPolicies` | **只能改配置文件** | **重启 dsh** |
| **插件侧** | 其余 16 个字段 | 设置页可改，也可改配置文件 | **改完立刻** |

两个原因，都是刻意的：

1. **它们不出现在表单里。** 设置服务只渲染有 volatile 祖先的字段，普通字段被当作
   「普通配置」排除。我们在 `schema.ts` 里把 DSH 内置压缩的 schema 原样铺开、**没有**标 volatile。
2. **即使改了也不会立刻生效。** DSH 内置压缩在构造时就把这些配置解析进自己的
   `this.config`，之后不再重读；而 volatile 提交不会重新构造实例。

把它们标成 volatile 会更糟：DSH 内置压缩按**值**读这些字段
（`config.headroomTokens ?? 65536`），拿到句柄会让它的算术出错、并在挂载时被
`validateKeys` 拒绝。所以它们保持普通值，只能走配置文件。

## 诚实的限制

- **笔记本的质量和及时性完全是模型的责任。** 插件不会自动补写、不会替你总结。
  模型没写或写得含糊，跨窗口后就是真的丢了细节——虽然还能用 `context_history` 从原文捞。
- **笔记本每写一次就是一条留在上下文里的消息。** 频繁重写会让上下文变大；
  这也正是提醒里要求「保持紧凑索引、整体替换而不是追加」的原因。
- **边界零开销 ≠ 整个过程零开销。** 写笔记本本身是一次工具调用，成本只是从前移到边界之前了。
- **父类会给摘要套一层外壳。** DSH 内置压缩把每段静态摘要包进
  `CHECKPOINT_PREAMBLE` + `<compacted-summary>`；除非重写整个事务，否则这层外壳去不掉。
  内层的 `<context-window-rollover>` 块是逐字保留的。
- **外部插件无法声明自有会话事件类型。** DSH 0.2.0-rc.2 要求未知事件类型携带 `ignorable`
  标记才能被重新加载，而 SDK 没有任何写入该标记的接口（详见 `src/notebook.ts` 顶部的论证）。
  所以笔记本落在 `user/message` 上，用自定义 `source.kind` 区分。
- 子代理等受限工具集的会话如果拿不到 `context_notes`，会自动退化成「无笔记本的滚动」。
- **`enabled: false` 不是「卸载」。** 工具在挂载时注册，volatile 提交不会重新挂载，
  所以关掉之后 `context_notes` / `context_history` 仍在模型的工具目录里，
  只是每次调用都会被拒绝（下一次调用起）。要让它们从目录里消失得重启 app。
- **基础压缩配置在设置页里看不到、也改不动，只能改配置文件并重启 dsh**（见上一节）。这是为了让它们继续按值工作，
  属于设计取舍而非遗漏。

## 开发

```sh
cd packages/dsh-notes-context
npm run typecheck
npm run build
npm test
```

## 许可

MIT
