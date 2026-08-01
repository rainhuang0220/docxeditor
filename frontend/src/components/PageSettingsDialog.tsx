import { useState } from 'react'
import { Settings, X } from 'lucide-react'

interface PageSettings {
  width: string
  height: string
  marginTop: string
  marginBottom: string
  marginLeft: string
  marginRight: string
}

const PAGE_PRESETS = {
  A4: { width: '210mm', height: '297mm' },
  Letter: { width: '8.5in', height: '11in' },
  Legal: { width: '8.5in', height: '14in' },
}

export function PageSettingsDialog() {
  const [isOpen, setIsOpen] = useState(false)
  const [settings, setSettings] = useState<PageSettings>({
    width: '210mm',
    height: '297mm',
    marginTop: '25.4mm',
    marginBottom: '25.4mm',
    marginLeft: '25.4mm',
    marginRight: '25.4mm',
  })

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
        title="Page Settings"
      >
        <Settings size={16} />
      </button>
    )
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setIsOpen(false)} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 rounded-lg shadow-xl z-50 w-96 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800 dark:text-gray-100">Page Settings</h3>
          <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-600 dark:text-gray-300 block mb-1">Page Size</label>
            <select
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-3 py-1.5 text-sm"
              onChange={e => {
                const preset = PAGE_PRESETS[e.target.value as keyof typeof PAGE_PRESETS]
                if (preset) setSettings(s => ({ ...s, ...preset }))
              }}
              defaultValue="A4"
            >
              <option value="A4">A4 (210 x 297 mm)</option>
              <option value="Letter">Letter (8.5 x 11 in)</option>
              <option value="Legal">Legal (8.5 x 14 in)</option>
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-600 dark:text-gray-300 block mb-1">Margins</label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Top</label>
                <input
                  type="text"
                  value={settings.marginTop}
                  onChange={e => setSettings(s => ({ ...s, marginTop: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Bottom</label>
                <input
                  type="text"
                  value={settings.marginBottom}
                  onChange={e => setSettings(s => ({ ...s, marginBottom: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Left</label>
                <input
                  type="text"
                  value={settings.marginLeft}
                  onChange={e => setSettings(s => ({ ...s, marginLeft: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Right</label>
                <input
                  type="text"
                  value={settings.marginRight}
                  onChange={e => setSettings(s => ({ ...s, marginRight: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-2 py-1 text-sm"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => setIsOpen(false)}
            className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('editor:set-page-style', {
                detail: {
                  width: settings.width,
                  minHeight: settings.height,
                  paddingTop: settings.marginTop,
                  paddingBottom: settings.marginBottom,
                  paddingLeft: settings.marginLeft,
                  paddingRight: settings.marginRight,
                },
              }))
              setIsOpen(false)
            }}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </div>
    </>
  )
}
