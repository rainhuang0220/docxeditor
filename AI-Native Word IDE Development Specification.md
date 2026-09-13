# AI-Native Word IDE Development Specification

> Historical planning document. It is not a description of the current tree.
> The shipping stack is React + TipTap + FastAPI + Tauri. MoonBit/Wasm was not built.
> Current AI mutation rules: [`GPT-HANDOFF.md`](./GPT-HANDOFF.md).

## Role

You are a senior full-stack engineer and system architect.

Your task is to design and implement a **local-first AI-native document IDE**.

The goal is not to build a Markdown AI writer.

The goal is:

> Build a Word-compatible document editing environment where AI agents can directly understand, modify, format, and generate professional documents through natural language interaction.

The final user experience should feel like:

```
Microsoft Word
+
Cursor IDE
+
AI Agent
```

------

# 1. Product Vision

Traditional workflow:

```
User writes text
        |
        |
Manual formatting
        |
        |
Export Word
```

Target workflow:

```
User intention
        |
        |
AI Agent understands requirement
        |
        |
Clarification if needed
        |
        |
Document operations
        |
        |
Rendered Word-like document
        |
        |
Export DOCX
```

The AI Agent is not a text generator.

It is a document manipulation system.

------

# 2. Product Requirements

## 2.1 Local-first Application

The first version must run locally.

No cloud deployment requirement.

Target:

```
Desktop application
```

Recommended:

```
Tauri
+
React
+
Python backend
+
MoonBit core runtime
```

Future deployment can be considered later.

------

# 3. High-Level Architecture

```
                   Desktop Application


                        Tauri


                         |
                         |


                 React Frontend


        --------------------------------

        Word-like Editor

        Traditional Toolbar

        AI Agent Panel

        Document Preview


                         |


                  Python API Layer


                         |


                  MoonBit Runtime


        --------------------------------

        Document Engine

        Operation Engine

        Diff Engine

        Version Engine


                         |


                DOCX Export Layer
```

------

# 4. Core Technology Decision

## Frontend

Use:

```
React
TypeScript
TailwindCSS
Tauri
```

Responsibilities:

- UI
- editor interaction
- toolbar
- AI chat
- document preview

------

# 5. Document Editor Architecture

## Critical Requirement

The left panel must NOT display:

- Markdown
- plain text
- code-like structure

It must display:

> The rendered appearance of a real Word document.

The user should feel:

"I am editing a .docx file."

Support:

- pages
- margins
- fonts
- paragraphs
- headings
- tables
- images
- page numbers
- headers
- footers
- styles

------

对，这里你的判断是对的。

上一版把 C 写成「长期 10/10，短期 2/10」，但**不应该替 Codex/Claude 预先排除它**。因为你现在的目的不是马上开发，而是：

> 让更强的模型基于完整 trade-off 选择最优路线。

尤其你的项目定位不是普通 SaaS，而是：

> **AI-native document operating system**

那么「自研完整 Word Engine」其实可能是最终壁垒所在。

所以应该把 C 放入正式架构评估，而不是作为废案。

下面是替换原 Prompt 中 **第 6 节 Editor Engine Trade-off Analysis** 的完整版。

------

# 6. Editor Engine Trade-off Analysis

The editor engine is the most important architectural decision.

The system must balance:

1. AI controllability
2. Microsoft Word compatibility
3. Rendering fidelity
4. Development complexity
5. Long-term technical moat

Evaluate the following three approaches.

------

# Option A — AI-native Structured Editor

## TipTap / ProseMirror + Custom Document Model

Architecture:

```
React

 |

TipTap Editor

 |

Abstract Document Model

 |

MoonBit Document Engine

 |

DOCX Export
```

## Concept

The editor is not a Word clone.

Instead:

Document is represented as a structured state.

AI modifies the document through operations.

Example:

```json
{
"type":"replace_block",
"target":"paragraph_2",
"content":"new content"
}
```

------

## Advantages

### AI controllability

Excellent.

The AI can naturally operate:

- paragraphs
- sections
- styles
- tables
- selections

Suitable for:

- AI rewriting
- AI formatting
- AI document generation

Score:

9.5/10

------

### Development speed

Fastest among three approaches.

Existing ecosystem:

- TipTap
- ProseMirror
- React

Score:

9/10

------

### AI-native architecture

Best match.

The document becomes:

```
State
+
Operations
+
History
```

Score:

10/10

------

## Disadvantages

### Word compatibility

Main challenge.

Potential issues:

- exact pagination
- complex layout
- floating objects
- advanced Word styles
- OOXML edge cases

Estimated:

Export to DOCX:

8/10 initially

Copy/paste into Word:

7-8/10

------

## Overall

| Category           | Score |
| ------------------ | ----- |
| AI capability      | 9.5   |
| Development speed  | 9     |
| Word compatibility | 7.5   |
| Long-term moat     | 7     |
| MVP suitability    | 10    |

Overall:

**8.5/10**

------

# Option B — Existing Office Engine Integration

## ONLYOFFICE / Collabora / LibreOffice Engine

Architecture:

```
React

 |

Office Engine

 |

DOCX

 |

AI Agent Integration
```

------

## Concept

Use an existing mature document rendering engine.

The system focuses on:

- AI assistant
- document understanding
- automation

------

## Advantages

### Microsoft Word compatibility

Best.

Supports:

- DOCX
- styles
- tables
- pagination
- complex layouts

Score:

10/10

------

### Development risk

Lower.

No need to recreate:

- layout engine
- pagination
- rendering

Score:

9/10

------

## Disadvantages

### AI-native difficulty

The document model belongs to the Office engine.

AI has difficulty performing:

- semantic editing
- structural transformation
- intelligent operations

Example:

User:

"Turn this report into a consulting proposal"

Harder because:

AI sees:

document commands

not:

semantic document tree

Score:

7/10

------

### Customization

Limited.

The product may become:

"Office + AI plugin"

instead of:

"AI-native document OS"

Score:

6.5/10

------

## Overall

| Category           | Score |
| ------------------ | ----- |
| AI capability      | 7     |
| Development speed  | 8     |
| Word compatibility | 10    |
| Long-term moat     | 6     |
| MVP suitability    | 8     |

Overall:

**8/10**

------

# Option C — Build a Complete Custom Word Engine

## Google Docs + Microsoft Word Layout Engine

Architecture:

```
React/Tauri

 |

Custom Editor Engine

 |

MoonBit Core

 |

Document Layout Engine

 |

DOCX/OOXML Export
```

------

## Concept

Do not imitate Word.

Build a new document runtime.

The system owns:

- document model
- layout engine
- rendering engine
- editing engine
- export engine

Similar philosophy:

```
Browser Engine
+
Google Docs Engine
+
Word Layout Engine
```

------

# Advantages

## Maximum AI-native capability

The document model can be designed around AI.

Example:

Traditional Word:

```
paragraph
run
style
xml
```

AI-native engine:

```
Intent

Section

Argument

Evidence

Citation

Layout

Style
```

The AI can reason directly about document meaning.

Score:

10/10

------

## Maximum long-term technical moat

Competitors can add:

- chat box
- AI rewrite button

But a complete document runtime is much harder.

Potential moat:

- proprietary document representation
- AI operation system
- rendering engine
- version system

Score:

10/10

------

## Best Word compatibility potential

Long term:

Can directly design:

- DOCX exporter
- OOXML mapping
- layout rules

Score:

10/10

------

# Disadvantages

## Extremely high engineering complexity

Need to build:

### Text engine

- cursor
- selection
- IME
- editing

### Layout engine

- pagination
- line breaking
- font metrics
- table layout

### Rendering engine

- canvas/WebGPU
- text shaping

### Compatibility layer

- DOCX import/export

Difficulty comparable to:

- browser engine
- PDF engine
- office suite

Score:

2/10 for MVP

------

## Development time

Estimated:

MVP:

6-18 months

Production quality:

Several years

------

## Overall

| Category           | Score |
| ------------------ | ----- |
| AI capability      | 10    |
| Development speed  | 2     |
| Word compatibility | 10    |
| Long-term moat     | 10    |
| MVP suitability    | 2     |

Overall:

Short term:

**4/10**

Long term:

**10/10**

------

# Strategic Recommendation

Do NOT decide only based on MVP speed.

Analyze whether the goal is:

## Product

or

## Technology moat

------

Recommended architecture evaluation:

## Short-term MVP

Option A:

```
TipTap
+
MoonBit Core
+
Python AI
+
DOCX Export
```

Reason:

Fast validation.

------

## Medium-term

Hybrid:

```
Custom Document Model

+

Better Renderer

+

Better DOCX Engine
```

------

## Long-term Vision

Move toward Option C:

```
MoonBit Document Runtime

+

Custom Layout Engine

+

AI Operation System
```

------

# Important Requirement

The implementation should avoid locking the system into Option A.

The abstraction layer should allow:

```
Current:

TipTap Renderer


Future:

Custom Word Engine Renderer


Same:

MoonBit Document Core

AI Operations

Version System
```

The final architecture decision should be made after evaluating:

1. AI-native capability
2. engineering cost
3. Word compatibility
4. future competitive advantage

------

这个版本更适合交给 Claude Opus / GPT-5.5 这种模型做架构判断。

另外我建议在最终 Prompt 最前面加一句：

> "Do not optimize only for MVP speed. Consider this project as a potential foundational AI document platform. Evaluate short-term feasibility and long-term moat separately."

否则很多模型会天然选择 A，因为它们倾向快速交付，而忽略 C 对你这个方向真正的战略价值。

------

# 7. Internal Document Representation

The storage format is an engineering decision.

Do NOT expose it to users.

Recommended:

Create an abstract document model.

Example:

```
Document

 |
 +-- Page

      |
      +-- Paragraph

      |
      +-- Heading

      |
      +-- Table

      |
      +-- Image

      |
      +-- Style
```

Example:

```json
{
"type":"paragraph",
"id":"p123",
"content":"example",
"style":{
 "font":"Times New Roman",
 "size":12
}
}
```

The model should support:

- rendering
- AI modification
- DOCX export
- version control

------

# 8. MoonBit Core Responsibility

MoonBit is the core document intelligence layer.

MoonBit DOES:

## Document Engine

Responsibilities:

- document tree
- structure
- styles
- relationships

------

## Operation Engine

AI does NOT directly modify documents.

AI outputs operations.

Example:

```json
{
"type":"rewrite",
"target":"paragraph_2",
"content":"new content"
}
```

MoonBit:

```
Operation

↓

Validate

↓

Apply

↓

Generate new state
```

------

## Diff Engine

Support:

```
Before

After

Difference
```

Required for:

- AI preview
- accept/reject
- rollback

------

## Version Engine

Every modification creates history.

Example:

```
Version 1

Original document


Version 2

AI changed introduction


Version 3

User formatting change
```

Support:

- undo
- redo
- compare
- rollback

------

MoonBit DOES NOT:

- UI
- AI API calls
- DOCX generation

Architecture:

```
React

 |

Python API

 |

MoonBit Runtime
```

------

# 9. AI Agent Design

The AI Agent is the main innovation.

It must behave like:

Professional editor + assistant.

------

# 10. Agent Workflow

## Simple command

Example:

User:

```
Make the title larger.
```

Agent:

Can execute immediately.

------

## Complex command

Example:

User:

```
Rewrite the second paragraph into academic style and add citations.
```

Agent MUST NOT directly modify.

It must ask clarification.

Example:

```
I need more information before editing.


Writing style:

[IEEE]
[APA]
[Nature]
[General Academic]


Citation:

[Real references]
[Placeholder references]
[Only format citations]


Modification level:

[Polish]
[Rewrite]
[Restructure]


Continue?
```

------

# 11. Agent Modes

Implement hybrid mode.

## Auto Execute

Low risk:

- font change
- alignment
- spacing
- simple formatting

------

## Confirmation Required

High impact:

- rewrite
- delete
- restructure
- add citations
- change document style

Workflow:

```
User request

↓

Agent analysis

↓

Clarification

↓

Modification proposal

↓

Diff preview

↓

User approval

↓

Apply
```

------

# 12. Agent Tools

Implement tool interface:

## Read tools

```
get_document()

get_selection()

get_outline()

get_styles()

get_paragraph()
```

------

## Write tools

```
insert_text()

replace_text()

rewrite_section()

delete_content()

change_style()

insert_table()

insert_image()

add_reference()
```

------

# 13. Traditional Toolbar

Keep normal Word toolbar.

Required:

```
Font

Size

Bold

Italic

Underline

Color

Alignment

Line spacing

Paragraph

Insert image

Insert table

Page settings
```

AI does not replace manual editing.

AI enhances it.

------

# 14. DOCX Export

Critical requirement:

Exported document must:

- open normally in Microsoft Word
- preserve formatting
- preserve layout

Workflow:

```
Document Model

        |

DOCX Generator

        |

.docx File
```

MVP:

Use:

```
python-docx
```

Future:

Support:

```
OOXML direct generation
```

------

# 15. Copy to Word Requirement

Important product requirement:

If user copies content from this editor into Microsoft Word:

Expected:

```
Visual result
=
same formatting
=
same structure
```

Need to investigate:

Possible approaches:

## Approach 1

Clipboard export:

```
HTML + CSS

+

RTF
```

Recommended.

------

## Approach 2

Direct DOCX clipboard object.

More difficult.

MVP:

Support:

```
HTML clipboard

+

RTF clipboard
```

------

# 16. Version Control

Need document history.

Similar to Git:

```
commit

|
|
document snapshot

|
|
diff
```

Each AI operation creates commit.

------

# 17. Backend

Python FastAPI.

Responsibilities:

- AI API communication
- document conversion
- export
- local file management

------

# 18. AI Model Support

MVP:

Support:

```
OpenAI API

Claude API
```

Architecture should allow future:

```
Ollama

Local LLM

Qwen

DeepSeek
```

------

# 19. Repository Structure

Recommended:

```
ai-document-ide/


frontend/

    React
    TypeScript
    Tauri


backend/

    FastAPI
    AI service
    DOCX exporter


moonbit-core/

    document/
    operation/
    diff/
    version/


docs/

tests/
```

------

# 20. MVP Development Plan

## Phase 1

Basic application:

Implement:

- Tauri desktop shell
- React UI
- three-panel layout

------

## Phase 2

Document editor:

Implement:

- TipTap editor
- toolbar
- page rendering

------

## Phase 3

MoonBit core:

Implement:

- document model
- operation system
- diff

------

## Phase 4

AI Agent:

Implement:

- chat panel
- tool calling
- clarification workflow
- diff preview

------

## Phase 5

DOCX:

Implement:

- export
- import
- clipboard compatibility

------

# 21. Engineering Principles

Never build:

```
LLM

↓

Markdown

↓

Copy paste

↓

Word
```

Build:

```
User Intent

↓

AI Agent

↓

Document Operations

↓

Document State

↓

Renderer

↓

DOCX
```

The final product should become:

> An AI-native document operating system, not an AI writing assistant.

------

# Initial Development Tasks

Before writing implementation code:

Create:

1. Complete architecture diagram
2. Repository initialization
3. Document model design
4. MoonBit module design
5. Agent tool schema
6. MVP milestone breakdown

Then begin implementation.

------

额外保留了两个未来扩展点：

1. **如果 Word 兼容性成为最大问题，可以替换 TipTap 层，不影响 MoonBit Core。**
2. **MoonBit 成为真正壁垒：不是 UI，而是 AI 操作文档的运行时。**

这个定位比单纯做「AI Word」更像一个新的 IDE 类产品。