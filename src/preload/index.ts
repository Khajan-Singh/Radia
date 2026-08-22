import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CH,
  type Artwork,
  type AudioFrame,
  type BridgeStatus,
  type DisplayInfo,
  type InitialState,
  type Palette,
  type PlayerMode,
  type Settings,
  type PanelSection,
  type Track,
  type TransportCommand
} from '../shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getState: (): Promise<InitialState> => ipcRenderer.invoke(CH.getState),

  patchSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(CH.patchSettings, patch),

  transport: (command: TransportCommand): Promise<void> => ipcRenderer.invoke(CH.transport, command),

  openAppearance: (section?: PanelSection): Promise<void> =>
    ipcRenderer.invoke(CH.openAppearance, section),
  toggleRim: (): Promise<void> => ipcRenderer.invoke(CH.toggleRim),
  setPlayerMode: (mode: PlayerMode): Promise<void> => ipcRenderer.invoke(CH.setPlayerMode, mode),
  windowAction: (action: 'minimize' | 'maximize' | 'close'): Promise<void> =>
    ipcRenderer.invoke(CH.windowAction, action),


  onSettings: (h: (s: Settings) => void): Unsubscribe => on(CH.settings, h),
  onTrack: (h: (t: Track) => void): Unsubscribe => on(CH.track, h),
  onArtwork: (h: (a: Artwork) => void): Unsubscribe => on(CH.artwork, h),
  onAudio: (h: (f: AudioFrame) => void): Unsubscribe => on(CH.audio, h),
  onPalette: (h: (p: Palette) => void): Unsubscribe => on(CH.palette, h),
  onDisplays: (h: (d: DisplayInfo[]) => void): Unsubscribe => on(CH.displays, h),
  onBridge: (h: (b: BridgeStatus) => void): Unsubscribe => on(CH.bridge, h),
  onRevealSection: (h: (s: PanelSection) => void): Unsubscribe => on(CH.revealSection, h)
}

export type RadiaApi = typeof api

contextBridge.exposeInMainWorld('radia', api)
