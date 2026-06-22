import { useState, useEffect } from 'react'

export function useMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768)

  useEffect(() => {
    function onResize() { setMobile(window.innerWidth < 768) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return mobile
}
