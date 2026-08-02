# AI Document IDE

AI 原生的文档编辑器桌面应用。基于 TipTap/ProseMirror 的富文本编辑器，集成 AI 助手，可以通过自然语言直接操作文档内容。

## 架构

```
┌─────────────────────────────────────────────┐
│  Tauri 2.x (Rust) — 桌面外壳               │
│  ┌───────────────────────────────────────┐  │
│  │  Frontend (React + TipTap + Tailwind) │  │
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │  Backend (FastAPI + python-docx)      │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- **前端**: React 19, TipTap 3, Tailwind CSS 4, Vite 8, TypeScript 6
- **后端**: FastAPI, python-docx, OpenAI/Anthropic SDKs
- **桌面**: Tauri 2.x 打包为原生 macOS 应用 (.dmg)

## 功能

### 编辑器
- 完整富文本编辑（加粗、斜体、下划线、删除线、高亮、上下标）
- 标题（H1–H3）、引用块、代码块（语法高亮）
- 表格：行列增删、单元格背景色、合并拆分
- 图片插入（上传、拖拽）+ 拖拽调整大小
- 文本对齐、字体、字号、颜色
- 有序/无序列表，支持嵌套
- 超链接、水平线、分页符
- 查找替换（正则 + 大小写敏感）
- 文档大纲面板（光标位置高亮）
- 版本历史 + diff 对比
- 全套键盘快捷键
- 右键上下文菜单
- 深色模式

### AI 助手
- 流式对话（SSE），Markdown 渲染
- 15 个原生 tool-calling 操作（替换内容、插入文本、格式化、建表等）
- 破坏性操作前展示 diff 预览，accept/reject 工作流
- 支持 OpenAI 和 Anthropic 双引擎
- 选区感知：AI 知道你选中了什么
- 快捷建议按钮

### 导入导出
- 导入 `.docx`：保留格式、嵌套列表、表格、图片（base64）、超链接
- 导出 `.docx`：标题、表格、图片、代码块、水平线、分页符
- 文档模板（报告、信件、简历、会议纪要、Newsletter、空白）

### 桌面应用
- Tauri 2.x 原生 macOS 应用
- `.dmg` 安装镜像 (arm64)
- 1280×800 默认窗口，可调整大小

## 快速开始

### 环境要求
- Node.js 20+
- Python 3.11+
- Rust 工具链（仅 Tauri 构建需要）

### 一次性安装（首次）

在**项目根目录**执行：

```bash
# 根依赖（concurrently / tauri cli）
npm install

# 前端
cd frontend && npm install && cd ..

# 后端虚拟环境
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ..

# （可选）API Key：复制 .env.example 为 .env 后填入
cp .env.example .env
```

### 日常启动（每次开发）

**务必在项目根目录** `/Users/.../docxeditor` 执行，不要进 `backend/` 或 `frontend/`：

```bash
npm run dev
```

这会同时拉起：
- 后端：`http://127.0.0.1:8000`（`--reload`，改代码自动生效）
- 前端：`http://localhost:5173/` ← **浏览器打开这个地址**

用完后在终端 `Ctrl+C` 停掉即可。

#### 分别启动（调试时）

开两个终端，都在项目根目录：

```bash
# 终端 1
bash start-backend.sh

# 终端 2
cd frontend && npm run dev
```

#### 端口被占用（`Address already in use` / 跳到 5174）

说明上次没关干净。先清掉再重新 `npm run dev`：

```bash
# 看谁占着
lsof -i :8000 -sTCP:LISTEN
lsof -i :5173 -sTCP:LISTEN

# 杀掉（把 PID 换成上面查到的）
kill <PID>
```

### AI 配置

两种方式任选其一：

1. **应用内**：工具栏钥匙图标 → 填 provider / API Key / model / base URL（会持久化到 `~/.docxeditor/config.json`）
2. **环境变量**：在项目根目录 `.env` 里写

```bash
OPENAI_API_KEY=sk-...
# 或
ANTHROPIC_API_KEY=sk-ant-...

# 可选
# OPENAI_MODEL=gpt-4o
# OPENAI_BASE_URL=https://...
```

### 构建桌面应用

```bash
# 项目根目录
npm run tauri:build
# 输出: src-tauri/target/release/bundle/dmg/DocxEditor_0.1.0_aarch64.dmg
```

## 项目结构

```
docxeditor/
├── frontend/
│   ├── src/
│   │   ├── components/      # UI 组件
│   │   ├── context/         # React Context
│   │   ├── extensions/      # TipTap 扩展
│   │   ├── templates/       # 文档模板
│   │   └── utils/           # 工具函数
│   └── package.json
├── backend/
│   ├── main.py              # FastAPI 路由
│   ├── ai_service.py        # AI 对话 + tool-calling
│   ├── export_service.py    # HTML → DOCX
│   └── import_service.py    # DOCX → HTML
├── src-tauri/               # Tauri 桌面外壳 (Rust)
└── package.json             # 根脚本
```

## 技术亮点

- **AI Tool-Calling**: 使用 OpenAI/Anthropic 原生函数调用能力，15 个工具定义，不是 JSON prompting
- **流式 SSE**: AI 回复逐 token 流式传输，前端实时更新
- **Diff 预览**: 破坏性操作展示 before/after 对比，用户确认后才应用
- **ProseMirror 事务**: AI 通过 ProseMirror transaction 操作文档，保留完整 undo/redo 历史
- **DOCX 双向转换**: 处理嵌套列表、单元格颜色、内联图片、超链接、代码块、水平线
