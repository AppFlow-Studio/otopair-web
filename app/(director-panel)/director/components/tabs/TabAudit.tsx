'use client'

import { useState } from 'react'
import { Button, Input, Select, GlobalAuditTable, IconSearch, IconExternal } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { AUDIT_ENTRIES } from '../../data'

const ACTION_LABELS: Record<string, string> = {
  refund_issued:    'Refund issued',
  refund_tagged:    'Refund tagged',
  payment_captured: 'Payment captured',
  note_added:       'Note added',
  status_change:    'Status change',
  assignee_change:  'Assignee change',
  field_edit:       'Field edit',
  email_sent:       'Email sent',
  flag_raised:      'Flag raised',
  viewed:           'Viewed (PII)',
}

export const TabAudit = () => {
  const [q, setQ] = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [actorFilter, setActorFilter] = useState('all')

  const actors = Array.from(new Set(AUDIT_ENTRIES.map(e => e.actor))).sort()

  const filtered = AUDIT_ENTRIES.filter(e => {
    if (actionFilter !== 'all' && e.action !== actionFilter) return false
    if (actorFilter !== 'all' && e.actor !== actorFilter) return false
    if (q) {
      const lq = q.toLowerCase()
      if (!e.detail.toLowerCase().includes(lq) && !(e.entity || '').toLowerCase().includes(lq) && !e.actor.toLowerCase().includes(lq)) return false
    }
    return true
  })

  return (
    <SectionAnchor id="audit" title="Audit log" subtitle="Every admin action, system event, and PII access across the platform — immutable."
      right={
        <Button variant="dark" iconRight={<IconExternal size={13} />}>Export CSV</Button>
      }>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)} placeholder="Search actions, entities, actors…" style={{ width:320 }} />
        <Select value={actionFilter} onChange={e => setActionFilter(e.target.value)}
          options={[{ value:'all', label:'All actions' }, ...Object.entries(ACTION_LABELS).map(([v, l]) => ({ value:v, label:l }))]} />
        <Select value={actorFilter} onChange={e => setActorFilter(e.target.value)}
          options={[{ value:'all', label:'All actors' }, ...actors.map(a => ({ value:a, label:a }))]} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>Showing {filtered.length} of {AUDIT_ENTRIES.length} entries</span>
      </div>
      <GlobalAuditTable entries={filtered} />
    </SectionAnchor>
  )
}
