export default function FilterChip({
  label, active, onClick,
}: {
  label:   string
  active:  boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-2 py-0.5 text-xs rounded-full border transition-colors',
        active
          ? 'bg-brand-600 text-white border-brand-600'
          : 'bg-white text-gray-600 border-border hover:border-brand-400',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
