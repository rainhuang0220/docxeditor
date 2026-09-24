/** One section. Lengths are OOXML twips, not a second document store. */

export interface PageSettings {
  widthTwip: number
  heightTwip: number
  marginTopTwip: number
  marginRightTwip: number
  marginBottomTwip: number
  marginLeftTwip: number
}

export const DEFAULT_PAGE_SETTINGS: PageSettings = {
  widthTwip: 11906,
  heightTwip: 16838,
  marginTopTwip: 1440,
  marginRightTwip: 1440,
  marginBottomTwip: 1440,
  marginLeftTwip: 1440,
}

const KNOWN_CSS: Record<number, string> = {
  11906: '210mm',
  16838: '297mm',
  12240: '8.5in',
  15840: '11in',
  20160: '14in',
  1440: '25.4mm',
  720: '12.7mm',
  1800: '1.25in',
}

export interface PageStyle {
  width: string
  minHeight: string
  paddingTop: string
  paddingBottom: string
  paddingLeft: string
  paddingRight: string
}

export function cssToTwip(value: string): number | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(mm|cm|in|pt)$/)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2]
  const inches = unit === 'in' ? amount : unit === 'mm' ? amount / 25.4 : unit === 'cm' ? amount / 2.54 : amount / 72
  if (!Number.isFinite(inches)) return null
  return Math.round(inches * 1440)
}

export function twipToCss(twip: number): string {
  return KNOWN_CSS[twip] ?? `${(twip / 1440).toFixed(4)}in`
}

export function toPageStyle(settings: PageSettings): PageStyle {
  return {
    width: twipToCss(settings.widthTwip),
    minHeight: twipToCss(settings.heightTwip),
    paddingTop: twipToCss(settings.marginTopTwip),
    paddingBottom: twipToCss(settings.marginBottomTwip),
    paddingLeft: twipToCss(settings.marginLeftTwip),
    paddingRight: twipToCss(settings.marginRightTwip),
  }
}

export function pageSettingsFromStyle(style: PageStyle): PageSettings {
  return {
    widthTwip: cssToTwip(style.width) ?? DEFAULT_PAGE_SETTINGS.widthTwip,
    heightTwip: cssToTwip(style.minHeight) ?? DEFAULT_PAGE_SETTINGS.heightTwip,
    marginTopTwip: cssToTwip(style.paddingTop) ?? DEFAULT_PAGE_SETTINGS.marginTopTwip,
    marginBottomTwip: cssToTwip(style.paddingBottom) ?? DEFAULT_PAGE_SETTINGS.marginBottomTwip,
    marginLeftTwip: cssToTwip(style.paddingLeft) ?? DEFAULT_PAGE_SETTINGS.marginLeftTwip,
    marginRightTwip: cssToTwip(style.paddingRight) ?? DEFAULT_PAGE_SETTINGS.marginRightTwip,
  }
}

export function parsePageSettings(input: unknown): PageSettings | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  const widthTwip = rec.widthTwip
  const heightTwip = rec.heightTwip
  const marginTopTwip = rec.marginTopTwip
  const marginRightTwip = rec.marginRightTwip
  const marginBottomTwip = rec.marginBottomTwip
  const marginLeftTwip = rec.marginLeftTwip
  const values = [widthTwip, heightTwip, marginTopTwip, marginRightTwip, marginBottomTwip, marginLeftTwip]
  if (!values.every(value => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 200000)) return null
  return { widthTwip, heightTwip, marginTopTwip, marginRightTwip, marginBottomTwip, marginLeftTwip } as PageSettings
}

let current = DEFAULT_PAGE_SETTINGS
const visual = new Set<(settings: PageSettings) => void>()
const persist = new Set<(settings: PageSettings) => void>()

export function getPageSettings(): PageSettings {
  return current
}

export function setPageSettings(next: PageSettings, options?: { quiet?: boolean }) {
  current = next
  for (const listener of visual) listener(next)
  if (!options?.quiet) {
    for (const listener of persist) listener(next)
  }
}

export function subscribePageStyle(listener: (settings: PageSettings) => void) {
  visual.add(listener)
  return () => { visual.delete(listener) }
}

export function subscribePageSettingsPersist(listener: (settings: PageSettings) => void) {
  persist.add(listener)
  return () => { persist.delete(listener) }
}
