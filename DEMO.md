# Demo 演示指南

## 演示前 30 秒准备

```bash
cd ~/Desktop/docxeditor
npm run dev        # 同时起后端(8000) + 前端(5173)
```

浏览器打开终端里打出的前端地址(通常 http://localhost:5173)。

**API Key(只需设置一次)**:点工具栏右侧的钥匙图标 → Provider 选 Anthropic → 填入 key、Model(如 `claude-sonnet-5`)、Base URL(如 `https://api.openai-next.com`)→ Test → Save。
现在 key 会持久化到 `~/.docxeditor/config.json`,后端重启也不会丢。

状态栏右下角显示绿色 "AI Ready" 即可开始。

## 桌面 App 方式(可选)

`src-tauri/target/release/bundle/macos/DocxEditor.app` 双击即可。app 启动时会自动:
1. 检测 8000 端口是否已有后端在跑(有则直接复用);
2. 没有则用项目 venv 自动拉起后端。

保险起见,演示用 `npm run dev` 的浏览器版最稳。

## 演示脚本(约 3 分钟)

### 1. 这是一个"真 Word",不是 Markdown(20 秒)
- 指出页面渲染:A4 纸张、页边距、Times New Roman、大纲面板、状态栏字数统计。
- 随手打几个字、加粗、变字号,展示这是完整的富文本编辑器。

### 2. AI 直接操作文档 —— 核心卖点(90 秒)
在右侧 AI 面板输入(实测可用的指令):

> 把文档标题改成"2026年度工作报告",并在文末插入一个3行3列的表格

AI 会通过 tool-calling 返回结构化操作并应用到文档 —— 标题变了、表格出现了、左侧大纲同步更新。

再来一条展示内容生成:

> 在 Introduction 下面写一段 200 字左右的项目背景介绍,并列出 3 条工作重点(用无序列表)

强调:**AI 不是输出 Markdown 让你复制粘贴,而是像 Cursor 改代码一样直接改文档**,每次修改进入版本历史(左下角 History),随时 Ctrl+Z 撤销。

### 3. 选中即改(30 秒)
- 用鼠标选中一段文字,出现浮动菜单;
- 或在 AI 面板输入"把我选中的这段改写得更正式" —— AI 知道你选中了什么。

### 4. 导出 DOCX 收尾(20 秒)
- 工具栏导出按钮 → 下载 .docx → 用 Word/Pages 打开,标题、表格、格式全部保留。
- 一句话总结:"从自然语言意图到可交付的 Word 文档,全程不碰格式刷。"

## 故障兜底

| 症状 | 处理 |
|---|---|
| AI 面板报错 / 状态栏不是 AI Ready | 点钥匙图标重新 Save 一次 key;确认后端终端没报错 |
| 8000 端口被占 | `lsof -nP -iTCP:8000 -sTCP:LISTEN` 找到 PID kill 掉,重跑 `npm run dev` |
| 前端端口变了 | 看 `npm run dev` 输出的实际端口(5173 被占会自动换 5174/5175) |
| 桌面 app AI 不工作 | 先跑 `bash start-backend.sh` 再开 app(app 会复用已运行的后端) |
