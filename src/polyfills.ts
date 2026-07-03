import { Buffer } from 'buffer'
import process from 'process'

declare global {
  interface Window {
    Buffer: typeof Buffer
    process: typeof process
  }
}

window.Buffer = window.Buffer ?? Buffer
window.process = {
  ...process,
  ...window.process,
  nextTick:
    process.nextTick ??
    ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      queueMicrotask(() => callback(...args))
    }),
}
