import { diffWords } from 'diff'

interface DiffViewProps {
  oldText: string
  newText: string
}

export function DiffView({ oldText, newText }: DiffViewProps) {
  const diffs = diffWords(oldText, newText)

  return (
    <div className="text-xs font-mono whitespace-pre-wrap leading-relaxed p-2 bg-white dark:bg-gray-900 border dark:border-gray-700 rounded max-h-48 overflow-y-auto">
      {diffs.map((part, i) => {
        if (part.added) {
          return <span key={i} className="bg-green-100 text-green-800">{part.value}</span>
        }
        if (part.removed) {
          return <span key={i} className="bg-red-100 text-red-800 line-through">{part.value}</span>
        }
        return <span key={i} className="text-gray-600">{part.value}</span>
      })}
    </div>
  )
}
