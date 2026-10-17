# dsh-notes-context

> 给 DeepSeek Harness 带来 omp（Oh My Pi）的 **笔记式上下文压缩**：
> 用模型维护的持久笔记本取代 LLM 摘要式压缩，窗口边界零模型调用。

[English](README.en.md) | 简体中文

---

## DSH 内置压缩机制

上下文接近窗口上限时，调用模型总结旧历史，并用总结替换原文。三个问题：

- **慢**：总结需等待模型返回。
- **不可靠**：总结质量取决于模型当次发挥。
- **原文丢失**：被替换的历史默认不再对模型可见。

本插件采用笔记本机制：**不总结，改记笔记。**

| | 内置压缩 | 本插件 |
|---|---|---|
| 边界处调用模型 | 是 | **否**（写入静态模板） |
| 边界可预测 | 否 | 是（本地、确定性） |
| 原文可回读 | 否 | **是**，按 seq |
| 什么信息重要 | 摘要模型决定 | 干活的模型自己决定 |

## 机制

### 笔记本 `context_notes`

模型在会话中维护一本笔记，记录任务状态、已定决策、改动过的文件、阻塞项、下一步。笔记跨窗口保留。

```
context_notes                    → 读取
context_notes { text: "..." }    → 整本替换（非追加）
context_notes { text: "" }       → 清空
```

上限 16 KiB（UTF-8 字节）。超出直接拒绝，不部分写入。

### 提醒（每窗口一次）

已使用的上下文接近压缩阈值时（距阈值不足 32,000 token），向模型注入一条提醒，要求更新笔记本。

提醒可忽略：模型不响应时压缩照常发生。它的作用是减少细节丢失。

### 窗口滚动（零模型调用）

到达压缩阈值时，复用 DSH 内置压缩的保留策略，仅替换总结步骤：写入固定过渡文本 + 当前笔记全文，不调用模型。

### 原文回读 `context_history`

滚动仅将被替换的历史移出模型可见范围，不删除（日志 append-only）。模型可按 seq 回读原文：

```
context_history                                 → 索引
context_history { from: 120, to: 200 }          → 指定区间
context_history { from: 0, to: 50, raw: true }  → 原文
```

## 配置

常用配置项如下。完整字段见设置页，推导过程见 [内部机制](https://github.com/sqzw-x/dsh-notes-context/blob/main/docs/INTERNALS.md)。

| 字段 | 默认 | 说明 |
|---|---|---|
| `thresholdTokens` | `-1` | 压缩阈值。绝对值优先：`450000` 即 450K，不随模型改变。`-1` 改用比例 `thresholdRatio` |
| `keepRecentTokens` | `20000` | 滚动后保留的原文上限，绝对值。实际保留量更大（裁剪以整条消息为单位） |
| `reserveTokens` | 留空 | 压缩阈值下方保留的余量。留空取窗口的 15%，不低于 16384。目标离窗口上限不足该值时，实际触发点会提前，最多提前该值 |

**触发点取两道上限里低的那道**：`min(目标, 窗口 − 输出预留 − 余量)`。声明了 `maxTokens` 的供应商（pi-ai 系列）会占掉窗口的四成左右，目标设高时会被这道上限截住。这是窗口的物理限制，不是配置错误；想让目标精确命中，就把 `reserveTokens` 设小。
| `reminderEnabled` | `true` | 是否注入提醒 |

**提醒位置无配置项**，由压缩阈值推导：

```
lead = min(32000, max(8192, floor(压缩阈值 × 0.125)))
```

压缩阈值 450,000 时提醒落在 **418,000**。调整提醒位置需调整压缩阈值。

**生效时机**：改完立即生效。`rolloverText`、`notebookSummaryMaxChars` 与两个 `static*` 标记例外——仅在写入边界时读取，故下次滚动才生效。

```yaml
- id: notes-context
  config:
    thresholdTokens: 450000
    keepRecentTokens: 20000
```

## 安装

```sh
# 从 npm 安装（发布后；预构建，无需本地构建）
dsh plugin --profile <profile> add dsh-notes-context
dsh --profile <profile> --dump-config   # 确认两层都生效
```

从 GitHub 源码安装也可以，但 pnpm 会要求允许本包运行构建脚本（`prepack` 生成 `lib/`）；把 pnpm 提示的 `allowBuilds` 条目写进 profile 的 `pnpm-workspace.yaml` 后重试：

```sh
dsh plugin --profile <profile> add github:sqzw-x/dsh-notes-context
```

组合包含两行 patch：停用 `compaction-basic`，挂载本包。

## 限制

- **笔记本质量由模型决定。** 插件不自动补写、不代为总结。模型未记录的信息需从原文回读。
- **每次写入都是一条留在上下文里的消息。** 频繁重写会增大上下文。
- **边界零开销 ≠ 全程零开销。** 写笔记本本身是一次工具调用，成本前移而非消除。
- **DSH 自身的压缩配置不可见、不可改**，只能改配置文件并重启 dsh（原因见 [内部机制](https://github.com/sqzw-x/dsh-notes-context/blob/main/docs/INTERNALS.md)）。
- 受限工具集的会话（如子代理）若无法调用 `context_notes`，退化为无笔记本的滚动。

## 开发

```sh
npm ci
npm run typecheck
npm run build
npm test
```

## 发布

发布走 npm **Trusted Publishing**（OIDC），CI 不需要长期 `NPM_TOKEN`。

1. **首次发布**：npm 上还没有 `dsh-notes-context`，先本地 `npm login` 后执行 `npm publish --access public`（或临时用一次性 token 在 CI 发），创建包并确定归属。
2. 在 npmjs.com 打开该包 → **Settings → Trusted publishing**，添加 GitHub Actions：
   - Organization or user: `sqzw-x`
   - Repository: `dsh-notes-context`
   - Workflow filename: `publish.yml`
   - Allowed actions: 勾选 **npm publish**（`npm stage publish` 默认允许）
3. 之后打 `v*` 标签即可由 `.github/workflows/publish.yml` 经 OIDC 发布；标签版本须与 `package.json` 一致。新配置要在 **2 天内完成一次成功发布**，否则过期；若 0.2.0 已手动发过，先 `npm version patch` 到 0.2.1 再打标签。
4. 验证通过后删掉 `NPM_TOKEN`，并在包的 Publishing access 里选 “Require two-factor authentication and disallow tokens”。

```sh
# 首版已手动发布过时：升到下一个版本并用 CI 验证 trusted publisher
npm version patch && git push --follow-tags

# 之后的版本
git tag "v$(node -pe 'require("./package.json").version')" && git push origin --tags
```

## 许可

MIT
