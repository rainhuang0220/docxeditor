/** File picker accept list and DOCX candidacy checks for Open DOCX / drop. */

/**
 * WKWebView maps `accept=".docx"` into UTIs that leave NSOpenPanel's Open
 * disabled and can hide valid .docx files. Leave accept unrestricted; validate
 * in the change/drop handlers and again on the authenticated import API.
 */
export const DOCX_FILE_ACCEPT = ''

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function isDocxFileCandidate(file: { name: string; type?: string }): boolean {
  const name = file.name.trim()
  if (name.toLowerCase().endsWith('.docx')) return true
  const type = (file.type || '').trim().toLowerCase()
  return type === DOCX_MIME
}
