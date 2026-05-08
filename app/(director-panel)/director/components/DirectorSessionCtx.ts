import { createContext } from 'react'

export type DirectorSession = {
  userId: string
  name: string
  role: string
  token: string
}

export const DirectorSessionCtx = createContext<DirectorSession | null>(null)
