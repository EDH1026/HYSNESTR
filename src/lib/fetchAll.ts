/**
 * fetchAllRows — PostgREST max_rows=1000 상한을 우회하는 범용 페이지네이션 루프.
 *
 * PostgREST는 서버 설정과 무관하게 응답을 기본 1000행으로 절단한다.
 * 클라이언트 .limit() 값도 이 상한을 초과할 수 없다.
 * 해결책: 명시적 .range(from, to) 요청을 반복하여 빈 페이지가 올 때까지 누적한다.
 *
 * 사용법:
 *   const rows = await fetchAllRows((from, to) =>
 *     supabase.from('table').select('*').order('col').range(from, to)
 *   )
 */
export async function fetchAllRows<T>(
  factory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  while (true) {
    const { data, error } = await factory(from, from + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return all
}
