'use client'

import { useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { NotesPanel } from './Primitives'
import type { Note } from '../data'
import { DirectorSessionCtx } from './DirectorSessionCtx'

export const DirectorNotesPanel = ({ entityType, entityId, placeholder }: {
  entityType: string
  entityId: string
  placeholder?: string
}) => {
  const session  = useContext(DirectorSessionCtx)
  const rawNotes = useQuery(api.director_notes.list, { entity_type: entityType, entity_id: entityId })
  const addNote  = useMutation(api.director_notes.add)

  const notes: Note[] = (rawNotes ?? []).map(n => ({
    author: n.author,
    when: new Date(n.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    text: n.text,
  }))

  const handleAdd = (text: string) => {
    addNote({
      entity_type: entityType,
      entity_id: entityId,
      author: session?.name ?? 'Director',
      actorId: session?.userId as Id<'director_users'> | undefined,
      text,
    })
  }

  return <NotesPanel notes={notes} onAdd={handleAdd} placeholder={placeholder} />
}
