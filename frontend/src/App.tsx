import './index.css'
import { Toolbar } from './components/Toolbar'
import { Editor } from './components/Editor'
import { AIPanel } from './components/AIPanel'
import { VersionPanel } from './components/VersionPanel'
import { StatusBar } from './components/StatusBar'
import { OutlinePanel } from './components/OutlinePanel'
import { FindReplaceBar } from './components/FindReplaceBar'
import { KeyboardShortcutsDialog } from './components/KeyboardShortcutsDialog'
import { SelectionMenu } from './components/SelectionMenu'
import { ContextMenu } from './components/ContextMenu'
import { TableToolbar } from './components/TableToolbar'
import { ToastContainer } from './components/Toast'
import { EditorProvider } from './context/EditorContext'
import { useEffect } from 'react'

function App() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('editor:open-find-replace'))
      }
      // Ctrl+S / Cmd+S: manual save version
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('editor:save-version', { detail: { description: 'Manual save' } }))
      }
      // Ctrl+P / Cmd+P: print
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        window.print()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <EditorProvider>
      <div className="flex flex-col h-screen">
        <Toolbar />
        <TableToolbar />
        <div className="flex flex-1 overflow-hidden">
          <OutlinePanel />
          <div className="flex-1 overflow-y-auto bg-gray-100 dark:bg-gray-900 relative">
            <FindReplaceBar />
            <SelectionMenu />
            <Editor />
            <VersionPanel />
          </div>
          <AIPanel />
        </div>
        <StatusBar />
        <KeyboardShortcutsDialog />
        <ContextMenu />
        <ToastContainer />
      </div>
    </EditorProvider>
  )
}

export default App
