import { useState } from 'react'
import { Settings, X } from 'lucide-react'
import { cssToTwip, DEFAULT_PAGE_SETTINGS, getPageSettings, setPageSettings, toPageStyle } from '../persistence/pageSettings'

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
        onClick={() => {
          const style = toPageStyle(getPageSettings())
          setSettings({
            width: style.width,
            height: style.minHeight,
            marginTop: style.paddingTop,
            marginBottom: style.paddingBottom,
            marginLeft: style.paddingLeft,
            marginRight: style.paddingRight,
          })
          setIsOpen(true)
        }}
        className="tool-btn w-[30px] h-[30px] grid place-items-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
        title="Page Settings"
      >
        <Settings size={16} />
      </button>
    )
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={() => setIsOpen(false)} />
      <div className="dialog-panel w-[420px] max-w-[90vw] p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="dialog-title">Page Settings</h3>
          <button onClick={() => setIsOpen(false)} className="dialog-close">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="field-label">Page Size</label>
            <select
              className="field-select"
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
            <label className="field-label">Margins</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Top</label>
                <input
                  type="text"
                  value={settings.marginTop}
                  onChange={e => setSettings(s => ({ ...s, marginTop: e.target.value }))}
                  className="field-input"
                />
              </div>
              <div>
                <label className="field-label">Bottom</label>
                <input
                  type="text"
                  value={settings.marginBottom}
                  onChange={e => setSettings(s => ({ ...s, marginBottom: e.target.value }))}
                  className="field-input"
                />
              </div>
              <div>
                <label className="field-label">Left</label>
                <input
                  type="text"
                  value={settings.marginLeft}
                  onChange={e => setSettings(s => ({ ...s, marginLeft: e.target.value }))}
                  className="field-input"
                />
              </div>
              <div>
                <label className="field-label">Right</label>
                <input
                  type="text"
                  value={settings.marginRight}
                  onChange={e => setSettings(s => ({ ...s, marginRight: e.target.value }))}
                  className="field-input"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={() => setIsOpen(false)} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => {
              setPageSettings({
                widthTwip: cssToTwip(settings.width) ?? DEFAULT_PAGE_SETTINGS.widthTwip,
                heightTwip: cssToTwip(settings.height) ?? DEFAULT_PAGE_SETTINGS.heightTwip,
                marginTopTwip: cssToTwip(settings.marginTop) ?? DEFAULT_PAGE_SETTINGS.marginTopTwip,
                marginBottomTwip: cssToTwip(settings.marginBottom) ?? DEFAULT_PAGE_SETTINGS.marginBottomTwip,
                marginLeftTwip: cssToTwip(settings.marginLeft) ?? DEFAULT_PAGE_SETTINGS.marginLeftTwip,
                marginRightTwip: cssToTwip(settings.marginRight) ?? DEFAULT_PAGE_SETTINGS.marginRightTwip,
              })
              setIsOpen(false)
            }}
            className="btn btn-primary"
          >
            Apply
          </button>
        </div>
      </div>
    </>
  )
}
