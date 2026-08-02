import { diffWords } from 'diff'

interface DiffViewProps {
  oldText: string
  newText: string
}

export function DiffView({ oldText, newText }: DiffViewProps) {
  const diffs = diffWords(oldText, newText)

  return (
    <div className="font-mono text-xs whitespace-pre-wrap leading-relaxed p-2.5 bg-[var(--color-surface-secondary)] border border-[var(--color-border-light)] max-h-48 overflow-y-auto text-[var(--color-text-secondary)]">
      {diffs.map((part, i) => {
        if (part.added) {
          return <span key={i} className="bg-[var(--color-success)]/20 text-[var(--color-success)]">{part.value}</span>
        }
        if (part.removed) {
          return <span key={i} className="bg-[var(--color-danger)]/20 text-[var(--color-danger)] line-through">{part.value}</span>
        }
        return <span key={i} className="text-[var(--color-text-tertiary)]">{part.value}</span>
      })}
    </div>
  )
}
