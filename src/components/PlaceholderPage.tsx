interface Props {
  title: string
  description: string
  icon: string
}

export default function PlaceholderPage({ title, description, icon }: Props) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center p-8">
      <div className="text-5xl mb-4">{icon}</div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">{title}</h1>
      <p className="text-muted max-w-md">{description}</p>
    </div>
  )
}
