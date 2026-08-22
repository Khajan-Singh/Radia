/// <reference types="vite/client" />
import type { RadiaApi } from '../../preload'

declare module '*?raw' {
  const content: string
  export default content
}

declare global {
  interface Window {
    radia: RadiaApi
  }
}

export {}
