# DocxEditor

Word 风格的桌面文档编辑器。AI 通过结构化操作改 TipTap/ProseMirror 文档，而不是把 HTML 直播进编辑器。

技术栈：React 19、TipTap 3、FastAPI、python-docx、Tauri 2。

这是仍在开发中的早期项目。它不是 Microsoft Word，不是无损 DOCX，也不是自带 Python 的独立安装包。

[English](README.md) · [简体中文](README.zh-CN.md)

## 状态

当前 `main` 上的 AI 编辑加固 **不包含** 在 v0.1.0 DMG 里：

- 对话走 SSE；文档只在终端结果上写入
- 请求时捕获文档、选区、光标、revision、线程身份
- 统一请求路径（选区菜单不自己 apply）
- 运行时解码 + 完整预检 + 一次原子 ProseMirror 事务
- 需确认的编辑走 Accept / Reject，pending 时禁止其它文档变更
- 非法、过期、中止、截断的结果不改文档

桌面包需要本机 Python 后端。开发请用浏览器路径 `npm run dev`。

## 现有能力

**编辑器。** H1–H3、常见 marks、列表、表格、块级图片、链接、代码块、引用、分页符、字体/字号/颜色/对齐、查找替换（含正则）、大纲、IndexedDB 文档与版本快照、模板、深色模式。

**AI。** OpenAI / Anthropic 原生 tool-calling。选区与光标在发送时冻结。模型输出经解码、按原始文档预检、一次事务提交。整篇替换 / 替换块 / 删除块需要 Accept 或 Reject。Key 可在应用内配置（`~/.docxeditor/config.json`）或写入 `.env`。

**DOCX。** 尽力导入导出标题、列表、表格、图片、超链接、分页符。不是无损往返。页眉页脚是界面占位。

## 限制

- 不是 Word 替代品
- v0.1.0 DMG 不带 Python 运行时；未签名
- Key 明文存储；无协作、无 Windows/Linux 预编译包

## 快速开始

需要 Node.js **22.12+**、Python **3.11+**。桌面构建另需 Rust **1.77.2+**。

```bash
npm install
cd frontend && npm install && cd ..

cd backend
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
cd ..

cp .env.example .env
npm run dev
```

- 后端 http://127.0.0.1:8000
- 前端 http://localhost:5173

## 测试

```bash
cd frontend && npm test && npm run build && cd ..
python3 -m backend.test_continuation
```

更完整的架构与安全说明见 [英文 README](README.md) 与 [`GPT-HANDOFF.md`](./GPT-HANDOFF.md)。

采用 [Apache License 2.0](LICENSE)（`Apache-2.0`）。
