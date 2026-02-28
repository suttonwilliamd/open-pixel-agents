// standaloneApi.ts - Replacement for vscodeApi.ts
// Provides SSE client and message handling for standalone mode

export type MessageHandler = (msg: any) => void

class StandaloneAPI {
  private handlers: MessageHandler[] = []
  private eventSource: EventSource | null = null
  
  // Connect to our Pixel Agents SSE server
  connect() {
    this.eventSource = new EventSource('/events')
    
    this.eventSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        this.handlers.forEach(h => h(msg))
      } catch (err) {
        console.error('Failed to parse message:', err)
      }
    }
    
    this.eventSource.onerror = () => {
      console.error('SSE connection error, reconnecting...')
      setTimeout(() => this.connect(), 3000)
    }
  }
  
  // Listen for messages from server
  onMessage(handler: MessageHandler) {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }
  
  // Send message to server (for future use - e.g., settings)
  postMessage(msg: any) {
    console.log('[StandaloneAPI] postMessage:', msg.type)
    // In standalone mode, we can add more endpoints as needed
    if (msg.type === 'saveAgentSeats') {
      // Could save to localStorage
      localStorage.setItem('agentSeats', JSON.stringify(msg.seats))
    }
  }
  
  disconnect() {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
  }
}

export const standalone = new StandaloneAPI()

// Audio notification sounds
let soundEnabled = true

export function setSoundEnabled(enabled: boolean) {
  soundEnabled = enabled
}

export function playDoneSound() {
  if (!soundEnabled) return
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.setValueAtTime(523, ctx.currentTime)
    osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1)
    osc.frequency.setValueAtTime(784, ctx.currentTime + 0.2)
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.4)
  } catch {}
}

export function playThinkingSound() {
  if (!soundEnabled) return
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.setValueAtTime(440, ctx.currentTime)
    gain.gain.setValueAtTime(0.2, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.2)
  } catch {}
}
