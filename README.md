# DocxEditor

AI 原生的文档编辑器桌面应用。基于 TipTap/ProseMirror 的富文本编辑，集成 AI 助手，用自然语言直接改文档——像 Cursor 改代码一样改 Word。

**仓库**: [github.com/rainhuang0220/docxeditor](https://github.com/rainhuang0220/docxeditor)

---

## Release

| 版本 | 平台 | 下载 |
|------|------|------|
| **v0.1.0** | macOS Apple Silicon (aarch64) | [DocxEditor_0.1.0_aarch64.dmg](https://github.com/rainhuang0220/docxeditor/releases/download/v0.1.0/DocxEditor_0.1.0_aarch64.dmg) |

完整 Release 页：[github.com/rainhuang0220/docxeditor/releases](https://github.com/rainhuang0220/docxeditor/releases)

安装：打开 DMG → 将 **DocxEditor** 拖入 Applications → 首次打开若被拦截，到「系统设置 → 隐私与安全性」允许运行。应用内点钥匙图标配置 OpenAI / Anthropic API Key 即可使用 AI。

仓库根目录也附带同版本 DMG（`DocxEditor_0.1.0_aarch64.dmg`），与 Release 资产一致。

---

## 当前架构（MVP）

```
┌─────────────────────────────────────────────────────┐
│  Tauri 2.x (Rust) — 桌面外壳 / 进程与资源管理        │
│  ┌───────────────────────────────────────────────┐  │
│  │  Frontend — React 19 + TipTap 3 + Tailwind 4  │  │
│  │  编辑器 · 大纲 · 版本 · AI 面板 · Diff 预览    │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  Backend — FastAPI + python-docx              │  │
│  │  AI tool-calling · DOCX 导入/导出 · SSE 流式  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

| 层 | 技术 | 职责 |
|----|------|------|
| 桌面壳 | **Rust** + Tauri 2 | 原生窗口、打包 `.app` / `.dmg`、后端 sidecar 拉起 |
| 前端 | React / TipTap / TypeScript | 富文本编辑、UI、ProseMirror 事务、diff accept/reject |
| 后端 | Python / FastAPI | AI 对话与 tool-calling、DOCX 双向转换 |
| 模型抽象 | `DocumentModel.ts` | 占位层，标注 *future MoonBit core*，便于后续替换引擎 |

MVP 有意裁掉了 Spec 中的 MoonBit 层：ProseMirror 已覆盖文档状态机 / history / schema 的大部分职责，先把产品闭环跑通。

---

## 后期架构路线

长期目标对齐 Spec 的 **Option C**：自研文档引擎 + 可验证的 AI 操作运行时，而不是永远绑死 TipTap。

```
目标形态（演进中）

  React UI ──────────────────────────────────────────┐
                                                     │
  TipTap / ProseMirror  ←→  逐步让出文档内核           │
                                                     ▼
              ┌────────────────────────────────────────┐
              │  MoonBit Core (Wasm)                   │
              │  Document · Operation · Diff · Version │
              └────────────────────────────────────────┘
                          ▲
                          │ 结构化 Operation（非直接改 DOM）
              ┌───────────┴───────────┐
              │  AI Gateway (Python→?) │
              │  tool-calling / 多模型 │
              └───────────────────────┘
                          ▲
              ┌───────────┴───────────┐
              │  Tauri / Rust Shell   │
              │  性能敏感路径下沉 Rust │
              └───────────────────────┘
```

### MoonBit Core（计划中）

编译为 **Wasm**，作为文档智能层（不是 UI、不是 DOCX 生成）：

| 模块 | 职责 |
|------|------|
| **Document Engine** | 文档树、结构、样式、节点关系 |
| **Operation Engine** | 校验并应用 AI 输出的结构化 Operation |
| **Diff Engine** | before/after，支撑 accept / reject / rollback |
| **Version Engine** | 版本图、undo/redo、对比与回滚 |

原则：**AI 不直接改文档**，只产出 Operation → MoonBit 验证 → 应用 → 新状态。  
引入方式应是**替换 ProseMirror 内核**，而不是在 TipTap 上再叠一层重复模型。占位见 `frontend/src/model/DocumentModel.ts`；未来目录预期为 `moonbit-core/`。

### Rust（已有 + 加深）

| 阶段 | 内容 |
|------|------|
| **现在** | Tauri 壳、窗口与打包、资源与后端进程管理 |
| **后期** | 大文档解析、并发 IO、与 Wasm/MoonBit 的宿主桥接；视需要把 DOCX 热路径或部分 sidecar 能力下沉到 Rust |

### 其他演进方向

- **AI 后端**：保留 OpenAI / Anthropic；扩展本地 / 国产模型（Ollama、Qwen、DeepSeek 等）
- **DOCX**：更高保真的节属性、页眉页脚、页码、样式表
- **引擎可替换**：UI 与 AI 网关稳定，文档内核可从 TipTap → MoonBit Runtime 迁移，而不推倒重来

更细的规格与取舍见 [`AI-Native Word IDE Development Specification.md`](./AI-Native%20Word%20IDE%20Development%20Specification.md) 与 [`SUMMARY.md`](./SUMMARY.md)。

---

## 功能概览

### 编辑器
- 富文本：加粗 / 斜体 / 下划线 / 删除线 / 高亮 / 上下标
- 标题 H1–H3、引用、代码块、表格、图片（拖拽缩放）
- 字体 / 字号 / 颜色 / 对齐、列表、链接、分页符
- 查找替换、大纲、版本历史 + diff、快捷键、右键菜单、深色模式

### AI 助手
- SSE 流式对话 + Markdown 渲染
- 15 个原生 tool-calling 操作（改内容、插表、格式化等）
- 破坏性操作前 diff 预览，accept / reject
- OpenAI + Anthropic；选区感知

### 导入导出
- `.docx` 双向：格式、嵌套列表、表格、图片、超链接等
- 模板：报告、信件、简历、会议纪要、Newsletter、空白

---

## 快速开始

### 环境要求
- Node.js 20+
- Python 3.11+
- Rust 工具链（仅 Tauri 构建需要）

### 一次性安装

在项目根目录：

```bash
npm install
cd frontend && npm install && cd ..

cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ..

cp .env.example .env   # 可选：填入 API Key
```

### 日常开发

```bash
npm run dev
```

- 后端：`http://127.0.0.1:8000`
- 前端：`http://localhost:5173`

分别启动：`bash start-backend.sh` + `cd frontend && npm run dev`。

端口占用时：

```bash
lsof -i :8000 -sTCP:LISTEN
lsof -i :5173 -sTCP:LISTEN
kill <PID>
```

### AI 配置

1. **应用内**：工具栏钥匙图标 → provider / API Key / model / base URL（持久化到 `~/.docxeditor/config.json`）
2. **环境变量**：根目录 `.env`

```bash
OPENAI_API_KEY=sk-...
# 或
ANTHROPIC_API_KEY=sk-ant-...
```

### 构建桌面应用

```bash
npm run tauri:build
# 输出示例: …/bundle/dmg/DocxEditor_0.1.0_aarch64.dmg
```

---

## 项目结构

```
docxeditor/
├── frontend/                 # React + TipTap UI
│   └── src/model/            # DocumentModel（未来 MoonBit 对接层）
├── backend/                  # FastAPI · AI · DOCX
├── src-tauri/                # Tauri / Rust 桌面壳
├── DocxEditor_0.1.0_aarch64.dmg
└── package.json
# 规划中: moonbit-core/       Document · Operation · Diff · Version
```

---

## 技术亮点

- **原生 Tool-Calling**：OpenAI / Anthropic function calling，不是 JSON prompting
- **流式 SSE**：逐 token 更新；可随时 abort
- **Diff 预览**：破坏性修改先对比再应用
- **ProseMirror 事务**：AI 改文档走 transaction，完整 undo/redo
- **DOCX 双向**：嵌套列表、单元格色、内联图、超链接、代码块、分页等
- **可演进内核**：Rust 壳已就位，MoonBit Wasm 文档运行时为下一阶段壁垒
