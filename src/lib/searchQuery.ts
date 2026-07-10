/**
 * parseSearchQuery — G-5 공용 검색어 파서
 *
 * 토큰화 후 OR/AND 그룹으로 파싱한다.
 * - 기본(공백 구분): 모든 토큰이 AND 조건
 * - 대문자 "OR" 연산자: 인접 토큰을 OR 그룹으로 묶는다
 * - 좌→우 파싱: "A OR B C" → (A OR B) AND C
 *
 * @param query 검색어 문자열
 * @returns (fields: string[]) => boolean 매치 판별 함수
 */
export function parseSearchQuery(query: string): (fields: string[]) => boolean {
  const raw = query.trim()
  if (!raw) return () => true

  const tokens = raw.split(/\s+/)

  // Build AND groups where each group is an OR-cluster of tokens
  const andGroups: string[][] = []
  let currentGroup: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === 'OR') continue
    if (i > 0 && tokens[i - 1] === 'OR' && currentGroup.length > 0) {
      currentGroup.push(token.toLowerCase())
    } else {
      if (currentGroup.length > 0) andGroups.push(currentGroup)
      currentGroup = [token.toLowerCase()]
    }
  }
  if (currentGroup.length > 0) andGroups.push(currentGroup)

  if (andGroups.length === 0) return () => true

  return (fields: string[]) => {
    const lf = fields.map(f => (f ?? '').toLowerCase())
    return andGroups.every(group =>
      group.some(term => lf.some(field => field.includes(term))),
    )
  }
}
