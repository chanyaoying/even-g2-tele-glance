/**
 * A Map with a size cap that forgets the least recently used entry first. Reading (`get`) and writing (`set`)
 * both count as a use. `has` does not, so a membership check never keeps an entry alive.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(readonly limit: number) {
    if (!(limit >= 1)) throw new Error('LruMap limit must be at least 1')
  }

  get size() {
    return this.entries.size
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    // Re-insert so the key moves to the most recently used end.
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  has(key: K) {
    return this.entries.has(key)
  }

  set(key: K, value: V) {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as K
      this.entries.delete(oldest)
    }
    return this
  }

  delete(key: K) {
    return this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }

  /** Keys from least to most recently used. */
  keys() {
    return this.entries.keys()
  }
}
