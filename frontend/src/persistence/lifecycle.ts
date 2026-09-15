export function isDocumentHidden(doc: { visibilityState?: string } = document): boolean {
  return doc.visibilityState === 'hidden'
}

export function bindPageLifecycle(flush: () => void): () => void {
  const onVisibility = () => {
    if (isDocumentHidden(document)) flush()
  }
  const onPageHide = () => {
    flush()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
  }
}
