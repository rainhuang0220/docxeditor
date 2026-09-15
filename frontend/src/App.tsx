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
import { ToastContainer, showToast } from './components/Toast'
import { EditorProvider } from './context/EditorContext'
import { PersistenceProvider, usePersistence } from './persistence/PersistenceContext'
import { useEffect } from 'react'

function AppShell() {
  const { createVersion, flushNow } = usePersistence()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('editor:open-find-replace'))
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('editor:open-find-replace', { detail: { focusReplace: true } }))
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void (async () => {
          try {
            await flushNow()
            await createVersion('Manual save')
            showToast('Version saved', 'success')
          } catch {
            /* durable failure is toasted by the persistence layer */
          }
        })()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('editor:trigger-print'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [createVersion, flushNow])

  return (
    <div className="flex flex-col h-screen">
      <Toolbar />
      <TableToolbar />
      <div className="flex flex-1 overflow-hidden">
        <OutlinePanel />
        <div className="flex-1 overflow-y-auto editor-canvas relative">
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
  )
}

function App() {
  return (
    <EditorProvider>
      <PersistenceProvider>
        <AppShell />
      </PersistenceProvider>
    </EditorProvider>
  )
}

export default App
