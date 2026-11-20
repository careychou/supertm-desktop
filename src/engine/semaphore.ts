export class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private max: number) {}

  /** Changes the limit in place: raising it starts queued callers now, lowering it lets running ones finish. */
  setMax(n: number) {
    this.max = Math.max(1, n)
    while (this.active < this.max && this.queue.length) { this.active++; this.queue.shift()!() }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.max) {
      // A waiter is woken with its slot already counted, so no other caller can take it first.
      await new Promise<void>((resolve, reject) => {
        const go = () => { signal?.removeEventListener('abort', onAbort); resolve() }
        const onAbort = () => { this.queue = this.queue.filter((q) => q !== go); reject(new Error('aborted')) }
        signal?.addEventListener('abort', onAbort, { once: true })
        this.queue.push(go)
      })
    } else this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      if (this.active < this.max && this.queue.length) { this.active++; this.queue.shift()!() }
    }
  }
}
