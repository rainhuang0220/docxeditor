import 'fake-indexeddb/auto'
import { Window } from 'happy-dom'

const win = new Window({ url: 'http://localhost/', width: 1024, height: 768 })

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

define('window', win)
define('document', win.document)
define('DOMParser', win.DOMParser)
define('Node', win.Node)
define('Element', win.Element)
define('HTMLElement', win.HTMLElement)
define('DocumentFragment', win.DocumentFragment)
define('MutationObserver', win.MutationObserver)
define('getComputedStyle', win.getComputedStyle.bind(win))
define('requestAnimationFrame', (cb: (t: number) => void) => win.requestAnimationFrame(cb))
define('cancelAnimationFrame', (id: number) => {
  try { win.cancelAnimationFrame(id as never) } catch { /* ignore */ }
})
try {
  define('navigator', win.navigator)
} catch {
  /* Node 24 navigator is a getter */
}

define('localStorage', win.localStorage)
define('sessionStorage', win.sessionStorage)
try {
  Object.defineProperty(win, 'indexedDB', { value: globalThis.indexedDB, configurable: true })
} catch {
  /* ignore */
}

const rangeProto = (win as unknown as { Range: { prototype: Record<string, unknown> } }).Range?.prototype
if (rangeProto) {
  if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = () => []
  if (typeof rangeProto.getBoundingClientRect !== 'function') {
    rangeProto.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON() { return this } })
  }
}
