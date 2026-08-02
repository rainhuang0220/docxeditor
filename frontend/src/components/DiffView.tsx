import { diffWords } from 'diff'

interface DiffViewProps {
  oldText: string
  newText: string
}

export function DiffView({ oldText, newText }: DiffViewProps) {
  const diffs = diffWords(oldText, newText)

  return (
    <div className="text-xs font-[var(--font-mono)] whitespace-pre-wrap leading-relaxed p-2.5 bg-[var(--color-surface-secondary)] border border-[var(--color-border-light)] rounded-md max-h-48 overflow-y-auto">
      {diffs.map((part, i) => {
        if (part.added) {
          return <span key={i} className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 rounded-[2px]">{part.value}</span>
        }
        if (part.removed) {
          return <span key={i} className="bg-red-500/15 text-red-700 dark:text-red-400 line-through rounded-[2px]">{part.value}</span>
        }
        return <span key={i} className="text-[var(--color-text-tertiary)]">{part.value}</span>
      })}
    </div>
  )
}
