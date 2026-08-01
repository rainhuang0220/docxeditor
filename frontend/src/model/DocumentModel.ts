/**
 * Abstract Document Model
 * This layer sits between the editor (TipTap) and the future MoonBit core.
 * It allows swapping the renderer without changing AI operations or version control.
 */

export interface DocumentStyle {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  alignment?: 'left' | 'center' | 'right' | 'justify'
  lineSpacing?: number
}

export interface DocumentNode {
  id: string
  type: 'paragraph' | 'heading' | 'table' | 'image' | 'list' | 'blockquote'
  content: string
  style: DocumentStyle
  children?: DocumentNode[]
  level?: number // for headings
  src?: string // for images
  rows?: string[][] // for tables
}

export interface DocumentState {
  id: string
  title: string
  nodes: DocumentNode[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface DocumentOperation {
  id: string
  type: 'insert' | 'delete' | 'replace' | 'style_change' | 'move' | 'replace_content'
  targetId?: string
  position?: number
  content?: string
  style?: Partial<DocumentStyle>
  timestamp: string
}

export interface DocumentVersion {
  version: number
  operations: DocumentOperation[]
  snapshot: DocumentState
  description: string
  timestamp: string
}

/**
 * Document Engine — manages document state and operations
 */
export class DocumentEngine {
  private state: DocumentState
  private history: DocumentVersion[] = []

  constructor(initialState?: Partial<DocumentState>) {
    this.state = {
      id: crypto.randomUUID(),
      title: initialState?.title || 'Untitled Document',
      nodes: initialState?.nodes || [],
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  getState(): DocumentState {
    return { ...this.state }
  }

  getHistory(): DocumentVersion[] {
    return [...this.history]
  }

  applyOperation(op: DocumentOperation): DocumentState {
    switch (op.type) {
      case 'insert':
        this.insertNode(op)
        break
      case 'delete':
        this.deleteNode(op)
        break
      case 'replace':
        this.replaceNode(op)
        break
      case 'style_change':
        this.changeStyle(op)
        break
      case 'replace_content':
        this.state.nodes = []
        break
    }

    this.state.version++
    this.state.updatedAt = new Date().toISOString()

    this.history.push({
      version: this.state.version,
      operations: [op],
      snapshot: { ...this.state },
      description: `Operation: ${op.type}`,
      timestamp: new Date().toISOString(),
    })

    return this.getState()
  }

  rollback(toVersion: number): DocumentState | null {
    const target = this.history.find(v => v.version === toVersion)
    if (!target) return null
    this.state = { ...target.snapshot }
    return this.getState()
  }

  private insertNode(op: DocumentOperation) {
    if (!op.content) return
    const node: DocumentNode = {
      id: crypto.randomUUID(),
      type: 'paragraph',
      content: op.content,
      style: op.style || {},
    }
    if (op.position !== undefined) {
      this.state.nodes.splice(op.position, 0, node)
    } else {
      this.state.nodes.push(node)
    }
  }

  private deleteNode(op: DocumentOperation) {
    if (!op.targetId) return
    this.state.nodes = this.state.nodes.filter(n => n.id !== op.targetId)
  }

  private replaceNode(op: DocumentOperation) {
    if (!op.targetId || !op.content) return
    const idx = this.state.nodes.findIndex(n => n.id === op.targetId)
    if (idx !== -1) {
      this.state.nodes[idx].content = op.content
    }
  }

  private changeStyle(op: DocumentOperation) {
    if (!op.targetId || !op.style) return
    const node = this.state.nodes.find(n => n.id === op.targetId)
    if (node) {
      node.style = { ...node.style, ...op.style }
    }
  }
}
