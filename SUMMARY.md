# 项目开发总结

> Historical MVP log. AI apply/undo/diff claims below are **stale**.
> Current behavior: [`README.md`](./README.md), [`GPT-HANDOFF.md`](./GPT-HANDOFF.md), [`CHANGELOG.md`](./CHANGELOG.md).
>
> In particular: the document is not live-written during SSE; confirmable ops apply then Accept/Reject; invalid batches do not mutate; Ctrl+Z after Accept returns the pre-AI document; Reject does not leave the proposal on the undo stack.

## 今日完成的功能

### 核心编辑器
- 基于 TipTap/ProseMirror 的富文本编辑器，支持完整格式化操作
- 标题（H1-H3）、引用、代码块（语法高亮）、表格、图片、列表
- 字体、字号、颜色、对齐方式
- 文本选中浮动菜单（bubble menu）
- 文档大纲面板，带光标位置追踪高亮
- 版本历史 + diff 对比
- 查找替换，支持正则和大小写敏感
- 右键上下文菜单（智能判断选区/表格状态）
- 深色模式
- 页面样式切换（A4/Letter/宽屏）

### AI 助手
- 流式对话（SSE），markdown 渲染
- 15 个原生 tool-calling 操作（替换内容、插入文本、格式化、建表等）
- 破坏性操作原子写入后 Accept / Reject（见仓库根 README；本节其余为 MVP 日记）
- 同时支持 OpenAI 和 Anthropic API
- 选区感知：AI 知道你选中了什么
- 快捷建议按钮

### 导入导出
- DOCX 导入：保留格式、嵌套列表、表格、图片（base64）、超链接
- DOCX 导出：标题、表格、图片、代码块、水平线、分页符
- 文档模板（报告、信件、简历、会议纪要、Newsletter）

### 桌面应用
- Tauri 2.x 打包为原生 macOS 应用
- 生成 `.dmg` 安装文件（`DocxEditor_0.1.0_aarch64.dmg`）
- 双击 DMG 即可安装到 Applications，像普通 app 一样打开使用
- 本质是 Rust 壳 + WebView，前端代码打包进二进制，后端作为 sidecar 运行

## 技术亮点

### AI Tool-Calling 架构
不是让 AI 输出 JSON 指令然后解析——而是使用 OpenAI/Anthropic 原生的 function calling 能力。AI 直接调用 `replace_content`、`insert_table` 等工具，可靠性远高于 prompt engineering 出来的 JSON。

### ProseMirror 事务操作
AI 通过 ProseMirror transaction 改文档。确认中的编辑会被锁住；Accept 后 Undo 回到 AI 之前；Reject 恢复快照且提案不得再出现在 Undo/Redo。

### DOCX 双向转换的复杂性
这是整个项目里最难的部分。python-docx 只提供低级的 XML 操作，嵌套列表需要解析 `w:numPr` → 查找 `w:abstractNum` → 判断 `w:numFmt` 来确定是有序还是无序。表格单元格背景色要从 `w:shd` 的 `w:fill` 属性提取。图片要从 relationship 拿到 blob 再 base64 编码。

### 流式 SSE + 实时 UI
AI 回复逐 token 流式传输，前端实时更新消息气泡。abort 控制器支持随时取消请求。

## 关于 DMG

Tauri 2.x 是类似 Electron 的桌面应用框架，但用 Rust 写壳，体积小很多（整个 app 约 10MB vs Electron 的 100MB+）。`npm run tauri:build` 会编译 Rust 代码 + 打包前端资源 → 生成 `.app` bundle → 再包装成 `.dmg` 安装镜像。双击 DMG 挂载后把 app 拖进 Applications 即可。

## 主观评价

- **最满意的功能**：AI tool-calling 工作流。确认类编辑先原子写入，再 Accept / Reject。
- **最难的部分**：DOCX 导入。Word 文档格式的复杂性远超预期，尤其是嵌套列表和混合格式的 run。
- **需要改进的**：UI 质感。功能完整但视觉粗糙，缺乏打磨。这是接下来要重点做的事。

---

## 对照原始 Specification 的选择与变更

原始规划文档：`AI-Native Word IDE Development Specification.md`

### 选择了 Option A（TipTap + Python AI + DOCX Export）

Spec 列出了三种架构路线：
- **Option A**：TipTap/ProseMirror + MoonBit Core + Python AI（MVP 评分 8.5/10）
- **Option B**：ONLYOFFICE/Collabora 现成引擎（8/10）
- **Option C**：完全自研 Word Engine + MoonBit Runtime（短期 4/10，长期 10/10）

实际选择了 Option A 的精简版——去掉了 MoonBit 层，直接用 TipTap + TypeScript + Python。

### MoonBit 为什么没了

Spec 第 8 节定义了 MoonBit 的四大职责：

| Spec 规划的 MoonBit 模块 | 实际实现方式 | 原因 |
|---|---|---|
| Document Engine（文档树、结构、样式） | TipTap/ProseMirror 内置 document model | ProseMirror 本身就是一个成熟的文档状态机，自带 schema、node/mark 系统，重复造轮子没有意义 |
| Operation Engine（验证、应用 AI 操作） | AI tool-calling → TipTap commands chain | TipTap 的 chain API 天然支持原子化操作，且与 undo 历史集成 |
| Diff Engine（前后对比） | 前端 JS diff（DiffView 组件） | 纯文本/HTML diff 用 JS 足够，不需要 Wasm 层 |
| Version Engine（undo/redo/rollback） | ProseMirror history plugin + 自建 VersionPanel | ProseMirror 的 history 已经是 production-grade 的 OT 实现 |

核心判断：**ProseMirror 已经是一个文档引擎**。Spec 设想的 MoonBit 层本质上是要在 ProseMirror 之外再建一套文档模型，这在 MVP 阶段引入了不必要的抽象和序列化开销。

保留了 `frontend/src/model/DocumentModel.ts` 作为抽象层占位，注释标注了 "future MoonBit core"，为后续迁移留口。

### 其他偏离 Spec 的决策

| Spec 要求 | 实际做法 | 原因 |
|---|---|---|
| MoonBit 编译为 Wasm 嵌入前端 | 未引入 Wasm | MVP 阶段 JS 性能足够，Wasm 增加构建复杂度 |
| Agent 多模式（Auto Execute / Confirmation） | 部分操作自动保留，破坏性操作 Accept/Reject | 见 `reviewTransaction.ts` |
| Agent 复杂指令需主动澄清 | 终端结果原子 apply，失败则不改文档 | 非法/中断失败封闭 |
| 页眉页脚 / 页码 | 仅在 Editor 组件中做了静态占位 | DOCX 的页眉页脚需要 section-level 支持，TipTap 不原生支持，留给后续 |
| `moonbit-core/` 目录结构 | 不存在 | 未引入 MoonBit |
| Spec 提到的 `get_document()` / `get_selection()` 等 read tools | 通过前端 context 直接传递选区文本给 AI | 不需要单独的 read tool，选区上下文随 chat 请求一起发送即可 |

### 总结

这次实现是 Spec 的**务实裁剪版**。Spec 的战略规划（MoonBit 作为长期技术壁垒、Option C 作为终极目标）仍然成立，但 MVP 阶段的判断是：

1. ProseMirror 已经覆盖了 MoonBit 在 Spec 中 80% 的职责
2. 引入 MoonBit → Wasm 会让构建链复杂度翻倍，debug 难度大增
3. AI tool-calling 直接操作 TipTap commands 已经足够可靠
4. 抽象层（DocumentModel.ts）保留了未来引入 MoonBit 的可能性

如果后续需要走向 Option C（自研 Word Engine），MoonBit 的引入点应该是**替换 ProseMirror**，而不是在 ProseMirror 之上再加一层。
