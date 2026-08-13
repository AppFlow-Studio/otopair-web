'use client'

import { useState, useContext, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Modal, Input, Select, tableStyles, IconX, IconCheck, IconSearch, IconChevronDown } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import {
  PART_SUBCATEGORIES,
  PART_SUBCATEGORY_BY_CODE,
  PART_SUBCATEGORY_GROUP_LABELS,
  PART_SUBCATEGORY_GROUP_ORDER,
  humanizeSubcategoryCode,
  type PartSubcategoryGroup,
} from '@/convex/lib/partSubcategories'

// ── types ───────────────────────────────────────────────────────────────────

type PartsKind = 'labor_only' | 'per_axle' | 'per_cylinder' | 'per_unit_spec' | 'per_wheel' | 'fixed_kit'

const PARTS_KIND_OPTIONS: { value: PartsKind; label: string }[] = [
  { value: 'labor_only',    label: 'Labor-only (no parts)' },
  { value: 'per_axle',      label: 'Per axle (booking position)' },
  { value: 'per_cylinder',  label: 'Per cylinder (engine spark plug count)' },
  { value: 'per_unit_spec', label: 'Per unit spec (engine capacity field)' },
  { value: 'per_wheel',     label: 'Per wheel (fixed 4)' },
  { value: 'fixed_kit',     label: 'Fixed kit (1 service = 1 kit)' },
]

const SPEC_SOURCE_OPTIONS = [
  { value: '',                                  label: '— Select engine field —' },
  { value: 'oil_capacity_qts',                  label: 'oil_capacity_qts' },
  { value: 'coolant_capacity_qts',              label: 'coolant_capacity_qts' },
  { value: 'transmission_fluid_capacity_qts',   label: 'transmission_fluid_capacity_qts' },
  { value: 'differential_fluid_capacity_qts',   label: 'differential_fluid_capacity_qts' },
]

type Row = {
  service: {
    id: Id<'services'>
    name: string
    slug: string | null
    category_id: Id<'service_categories'> | null
    category_name: string | null
    parts_kind: PartsKind | null
    parts_unit_label: string | null
    parts_unit_spec_source: string | null
    default_labor_hours: number | null
  }
  rule: {
    id: Id<'service_parts_rules'>
    parts_kind: PartsKind
    parts_unit_label: string | null
    parts_unit_spec_source: string | null
    core_subcategories: string[]
    as_needed_subcategories: string[]
    pinned_parts: { subcategory: string; part_id: Id<'oem_parts'>; is_core: boolean }[]
    qty_override: number | null
    updated_at: number
  } | null
}

type FilterKey = 'all' | PartsKind | 'unconfigured'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all',           label: 'All' },
  { key: 'labor_only',    label: 'Labor-only' },
  { key: 'per_axle',      label: 'Per axle' },
  { key: 'per_cylinder',  label: 'Per cylinder' },
  { key: 'per_unit_spec', label: 'Per unit spec' },
  { key: 'per_wheel',     label: 'Per wheel' },
  { key: 'fixed_kit',     label: 'Fixed kit' },
  { key: 'unconfigured',  label: 'Unconfigured' },
]

// ── subcategory chip + picker ───────────────────────────────────────────────

type SubcategoryUsage = { oem_parts_count: Record<string, number>; used_in_rules: string[] }

function SubcategoryChip({ code, tone, onRemove }: { code: string; tone: 'core' | 'as_needed'; onRemove: () => void }) {
  const label = humanizeSubcategoryCode(code)
  const known = PART_SUBCATEGORY_BY_CODE[code]
  const palette = tone === 'core'
    ? { bg:'var(--blue-50)',   fg:'var(--blue-700)',   bd:'#BFDBFE' }
    : { bg:'var(--orange-50)', fg:'var(--orange-700)', bd:'#FED7AA' }
  return (
    <span title={known ? `${code} · ${known.hint ?? ''}` : `${code} (custom)`}
      style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'4px 10px', borderRadius:999,
        fontSize:12, fontWeight:500, background:palette.bg, color:palette.fg, border:`1px solid ${palette.bd}` }}>
      <span>{label}</span>
      {!known && (
        <span style={{ fontSize:10, fontWeight:600, opacity:0.7, textTransform:'uppercase', letterSpacing:'0.04em' }}>
          custom
        </span>
      )}
      <button onClick={onRemove}
        style={{ border:'none', background:'transparent', cursor:'pointer', color:palette.fg, display:'inline-flex', padding:0, opacity:0.7 }}>
        <IconX size={12} />
      </button>
    </span>
  )
}

function SubcategoryChipList({ items, tone, onRemove, emptyHint }: {
  items: string[]
  tone: 'core' | 'as_needed'
  onRemove: (s: string) => void
  emptyHint?: string
}) {
  if (items.length === 0) {
    return <span style={{ fontSize:12, color:'var(--slate-400)' }}>{emptyHint ?? '—'}</span>
  }
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
      {items.map(s => <SubcategoryChip key={s} code={s} tone={tone} onRemove={() => onRemove(s)} />)}
    </div>
  )
}

/**
 * Grouped, searchable subcategory picker. Collapsed by default; click
 * "+ Add subcategory" to expand. Type to filter by label or code; results
 * are grouped by taxonomy category. Already-added items are dimmed.
 * Free-text custom entries are supported at the bottom for edge cases.
 */
function SubcategoryPicker({ usage, exclude, onAdd }: {
  usage: SubcategoryUsage | undefined
  exclude: string[]
  onAdd: (code: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [customDraft, setCustomDraft] = useState('')
  const excludeSet = useMemo(() => new Set(exclude), [exclude])

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: { group: PartSubcategoryGroup; items: typeof PART_SUBCATEGORIES }[] = []
    for (const g of PART_SUBCATEGORY_GROUP_ORDER) {
      const items = PART_SUBCATEGORIES.filter(e => e.group === g)
        .filter(e => q === '' || e.code.includes(q) || e.label.toLowerCase().includes(q))
      if (items.length > 0) out.push({ group: g, items })
    }
    return out
  }, [query])

  // Extra subcategories that exist in the rules / oem_parts but aren't in
  // the canonical taxonomy. Surface them in a "Custom / unknown" group so
  // legacy free-text doesn't disappear.
  const orphans = useMemo(() => {
    if (!usage) return [] as string[]
    const taxonomy = new Set(PART_SUBCATEGORIES.map(e => e.code))
    const all = new Set<string>([
      ...Object.keys(usage.oem_parts_count),
      ...usage.used_in_rules,
    ])
    const q = query.trim().toLowerCase()
    return Array.from(all)
      .filter(c => !taxonomy.has(c))
      .filter(c => q === '' || c.toLowerCase().includes(q))
      .sort()
  }, [usage, query])

  const addAndReset = (code: string) => {
    if (!code || excludeSet.has(code)) return
    onAdd(code)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 12px', borderRadius:8,
          fontSize:12, fontWeight:500, color:'var(--blue-700)', background:'var(--blue-50)',
          border:'1px solid #BFDBFE', cursor:'pointer' }}>
        + Add subcategory
      </button>
    )
  }

  return (
    <div style={{ border:'1px solid var(--slate-200)', borderRadius:10, background:'#fff', overflow:'hidden' }}>
      {/* Header: search + close */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderBottom:'1px solid var(--slate-100)', background:'var(--slate-25)' }}>
        <div style={{ flex:1 }}>
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name or code (e.g. brake, oil, tpms)…"
            icon={<IconSearch size={14} />}
          />
        </div>
        <button onClick={() => { setOpen(false); setQuery(''); setCustomDraft('') }}
          style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-500)', padding:6, display:'inline-flex', borderRadius:6 }}
          title="Close picker">
          <IconChevronDown size={16} />
        </button>
      </div>

      {/* Grouped list */}
      <div style={{ maxHeight:260, overflow:'auto' }}>
        {grouped.length === 0 && orphans.length === 0 && (
          <div style={{ padding:16, fontSize:12, color:'var(--slate-500)' }}>
            No matches. Add it as a custom subcategory below.
          </div>
        )}
        {grouped.map(({ group, items }) => (
          <div key={group}>
            <div style={{ position:'sticky', top:0, padding:'6px 12px', fontSize:10, fontWeight:600,
              color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em',
              background:'var(--slate-50)', borderBottom:'1px solid var(--slate-100)' }}>
              {PART_SUBCATEGORY_GROUP_LABELS[group]}
            </div>
            {items.map(e => {
              const already = excludeSet.has(e.code)
              const count = usage?.oem_parts_count[e.code] ?? 0
              return (
                <button key={e.code} onClick={() => addAndReset(e.code)} disabled={already}
                  style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'9px 12px',
                    border:'none', background:already ? 'var(--slate-25)' : '#fff', cursor:already ? 'not-allowed' : 'pointer',
                    borderBottom:'1px solid var(--slate-100)', textAlign:'left',
                    opacity:already ? 0.55 : 1 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{e.label}</div>
                    <div style={{ fontSize:11, color:'var(--slate-500)', fontFamily:'monospace', marginTop:1 }}>
                      {e.code}
                      {e.hint && <span style={{ fontFamily:'inherit', color:'var(--slate-400)' }}> · {e.hint}</span>}
                    </div>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                    {count > 0 && (
                      <span style={{ fontSize:11, color:'var(--slate-500)' }}>{count} part{count === 1 ? '' : 's'}</span>
                    )}
                    {already ? (
                      <Badge tone="slate">Added</Badge>
                    ) : (
                      <span style={{ fontSize:11, fontWeight:600, color:'var(--blue-600)' }}>Add</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        ))}
        {orphans.length > 0 && (
          <div>
            <div style={{ position:'sticky', top:0, padding:'6px 12px', fontSize:10, fontWeight:600,
              color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em',
              background:'var(--slate-50)', borderBottom:'1px solid var(--slate-100)' }}>
              Custom / Unknown
            </div>
            {orphans.map(code => {
              const already = excludeSet.has(code)
              const count = usage?.oem_parts_count[code] ?? 0
              return (
                <button key={code} onClick={() => addAndReset(code)} disabled={already}
                  style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'9px 12px',
                    border:'none', background:already ? 'var(--slate-25)' : '#fff', cursor:already ? 'not-allowed' : 'pointer',
                    borderBottom:'1px solid var(--slate-100)', textAlign:'left', opacity:already ? 0.55 : 1 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{humanizeSubcategoryCode(code)}</div>
                    <div style={{ fontSize:11, color:'var(--slate-500)', fontFamily:'monospace', marginTop:1 }}>{code}</div>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                    {count > 0 && <span style={{ fontSize:11, color:'var(--slate-500)' }}>{count} part{count === 1 ? '' : 's'}</span>}
                    {already ? <Badge tone="slate">Added</Badge> : <span style={{ fontSize:11, fontWeight:600, color:'var(--blue-600)' }}>Add</span>}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Free-text escape hatch */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderTop:'1px solid var(--slate-100)', background:'var(--slate-25)' }}>
        <div style={{ flex:1 }}>
          <Input value={customDraft} onChange={e => setCustomDraft(e.target.value)} placeholder="Add custom subcategory (snake_case)" />
        </div>
        <Button onClick={() => { const v = customDraft.trim(); if (v) { addAndReset(v); setCustomDraft('') } }}
          disabled={customDraft.trim() === ''}>
          Add custom
        </Button>
      </div>
    </div>
  )
}

// ── edit modal ──────────────────────────────────────────────────────────────

// `mode` is non-null when the modal is open. The parent conditionally mounts
// the modal so each open creates a fresh component instance and the useState
// initializers below pick up the row's current rule data.
type ModalMode = { kind: 'edit'; row: Row } | { kind: 'create' }

const PartsRuleModal = ({ mode, onClose, usage, serviceCategories }: {
  mode: ModalMode
  onClose: () => void
  usage: SubcategoryUsage | undefined
  serviceCategories: { id: Id<'service_categories'>; name: string }[]
}) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const upsert    = useMutation(api.director_service_parts.upsertRule)
  const create    = useMutation(api.director_service_parts.createService)

  // Create-mode-only fields
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [newCategoryId, setNewCategoryId] = useState<string>('')
  const [newLaborHours, setNewLaborHours] = useState('')

  // Shared rule fields — initialized from the row (edit) or sensible defaults
  // (create). The parent remounts this component on each open so initial
  // values are picked up reliably.
  const initial = mode.kind === 'edit' ? mode.row : null
  const [partsKind, setPartsKind] = useState<PartsKind>(
    initial?.rule?.parts_kind ?? initial?.service.parts_kind ?? 'labor_only'
  )
  const [unitLabel, setUnitLabel] = useState(
    initial?.rule?.parts_unit_label ?? initial?.service.parts_unit_label ?? ''
  )
  const [specSource, setSpecSource] = useState(
    initial?.rule?.parts_unit_spec_source ?? initial?.service.parts_unit_spec_source ?? ''
  )
  const [coreSubs, setCoreSubs] = useState<string[]>(initial?.rule?.core_subcategories ?? [])
  const [asNeededSubs, setAsNeededSubs] = useState<string[]>(initial?.rule?.as_needed_subcategories ?? [])
  const [pinned, setPinned] = useState<{ subcategory: string; part_id: Id<'oem_parts'>; is_core: boolean }[]>(
    initial?.rule?.pinned_parts ?? []
  )
  const [qtyOverride, setQtyOverride] = useState<string>(
    initial?.rule?.qty_override != null ? String(initial.rule.qty_override) : ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pinned-part picker state
  const [pinSubcategoryDraft, setPinSubcategoryDraft] = useState('')
  const pinSubcategoryQuery = pinSubcategoryDraft.trim()
  const partsForPin = useQuery(
    api.director_service_parts.partsBySubcategory,
    pinSubcategoryQuery ? { subcategory: pinSubcategoryQuery, limit: 50 } : 'skip'
  )

  const isCreate = mode.kind === 'create'
  const title = isCreate ? 'New service' : `Edit · ${mode.row.service.name}`

  const submit = async () => {
    setError(null)
    setSaving(true)
    try {
      const qty = qtyOverride.trim() === '' ? undefined : Number(qtyOverride)
      if (qty != null && (!Number.isFinite(qty) || qty < 0)) {
        setError('Quantity override must be a non-negative number')
        setSaving(false)
        return
      }
      if (partsKind === 'per_unit_spec' && !specSource) {
        setError('Engine spec source is required for per_unit_spec')
        setSaving(false)
        return
      }
      const common = {
        parts_kind: partsKind,
        parts_unit_label: unitLabel.trim() || undefined,
        parts_unit_spec_source: specSource || undefined,
        core_subcategories: coreSubs,
        as_needed_subcategories: asNeededSubs,
        pinned_parts: pinned,
        qty_override: qty,
        actorName,
        actorId,
      }
      if (isCreate) {
        const name = newName.trim()
        if (!name) { setError('Name is required'); setSaving(false); return }
        const labor = newLaborHours.trim() === '' ? undefined : Number(newLaborHours)
        const res = await create({
          ...common,
          name,
          slug: newSlug.trim() || undefined,
          service_category_id: newCategoryId ? (newCategoryId as Id<'service_categories'>) : undefined,
          default_labor_hours: labor,
        })
        if (!res.ok) { setError(`Create failed: ${res.reason}`); setSaving(false); return }
      } else {
        const res = await upsert({
          ...common,
          service_id: mode.row.service.id,
        })
        if (!res.ok) { setError(`Save failed: ${res.reason}`); setSaving(false); return }
      }
      setSaving(false)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Unexpected error')
      setSaving(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={title}
      eyebrow={<span style={{ fontSize:11, fontWeight:600, color:'var(--blue-600)', letterSpacing:'0.04em', textTransform:'uppercase' }}>Service parts rule</span>}
      width={760}
      footer={(
        <>
          {error && <span style={{ fontSize:12, color:'var(--red-600)', marginRight:'auto' }}>{error}</span>}
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving} icon={<IconCheck size={14} />}>
            {saving ? 'Saving…' : (isCreate ? 'Create service' : 'Save rule')}
          </Button>
        </>
      )}
    >
      <div style={{ padding:'18px 22px', display:'flex', flexDirection:'column', gap:18 }}>
        {isCreate && (
          <Section title="Service identity">
            <Field label="Name">
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Cabin Air Freshener" />
            </Field>
            <Field label="Slug (optional · auto-derived from name)">
              <Input value={newSlug} onChange={e => setNewSlug(e.target.value)} placeholder="cabin_air_freshener" />
            </Field>
            <Field label="Service category">
              <Select
                value={newCategoryId}
                onChange={e => setNewCategoryId(e.target.value)}
                options={[{ value: '', label: '— None —' }, ...serviceCategories.map(c => ({ value: String(c.id), label: c.name }))]}
              />
            </Field>
            <Field label="Default labor hours">
              <Input type="number" value={newLaborHours} onChange={e => setNewLaborHours(e.target.value)} placeholder="0.5" />
            </Field>
          </Section>
        )}

        <Section title="Quantification">
          <Field label="Parts kind">
            <Select
              value={partsKind}
              onChange={e => setPartsKind(e.target.value as PartsKind)}
              options={PARTS_KIND_OPTIONS}
            />
          </Field>
          <Field label="Unit label (display copy)">
            <Input value={unitLabel} onChange={e => setUnitLabel(e.target.value)} placeholder="axle · cyl · qt · wheel · kit · filter" />
          </Field>
          {partsKind === 'per_unit_spec' && (
            <Field label="Engine spec source (engines.* field)">
              <Select value={specSource} onChange={e => setSpecSource(e.target.value)} options={SPEC_SOURCE_OPTIONS} />
            </Field>
          )}
          <Field label="Quantity override (wins over resolver · leave blank to use resolver)">
            <Input type="number" value={qtyOverride} onChange={e => setQtyOverride(e.target.value)} placeholder="—" />
          </Field>
        </Section>

        <Section title="Core subcategories (always billable)">
          <SubcategoryChipList items={coreSubs} tone="core"
            onRemove={s => setCoreSubs(coreSubs.filter(c => c !== s))}
            emptyHint="No core subcategories" />
          <SubcategoryPicker usage={usage} exclude={[...coreSubs, ...asNeededSubs]}
            onAdd={s => setCoreSubs([...coreSubs, s])} />
        </Section>

        <Section title="As-needed subcategories (situational discovery items)">
          <SubcategoryChipList items={asNeededSubs} tone="as_needed"
            onRemove={s => setAsNeededSubs(asNeededSubs.filter(c => c !== s))}
            emptyHint="None" />
          <SubcategoryPicker usage={usage} exclude={[...coreSubs, ...asNeededSubs]}
            onAdd={s => setAsNeededSubs([...asNeededSubs, s])} />
        </Section>

        <Section title="Pinned OEM parts (short-circuit the 7-layer selector)">
          {pinned.length === 0 && <span style={{ fontSize:12, color:'var(--slate-400)' }}>None — resolver behavior unchanged.</span>}
          {pinned.map((p, i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', border:'1px solid var(--slate-200)', borderRadius:8 }}>
              <Badge tone={p.is_core ? 'blue' : 'orange'}>{p.is_core ? 'Core' : 'As-needed'}</Badge>
              <span style={{ fontSize:12, color:'var(--slate-700)', fontFamily:'monospace' }}>{p.subcategory}</span>
              <span style={{ flex:1, fontSize:11, color:'var(--slate-500)' }}>part_id: {String(p.part_id).slice(-8)}…</span>
              <button onClick={() => setPinned(pinned.filter((_, idx) => idx !== i))}
                style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-500)' }}>
                <IconX size={14} />
              </button>
            </div>
          ))}
          <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:8 }}>
            <Field label="Subcategory to pin">
              <Input value={pinSubcategoryDraft} onChange={e => setPinSubcategoryDraft(e.target.value)}
                placeholder="Type an exact subcategory then pick a part below" />
            </Field>
            {partsForPin && partsForPin.length > 0 && (
              <div style={{ display:'flex', flexDirection:'column', gap:4, maxHeight:200, overflow:'auto',
                border:'1px solid var(--slate-200)', borderRadius:8 }}>
                {partsForPin.map(p => (
                  <button key={String(p.id)}
                    onClick={() => {
                      const isCoreMatch = coreSubs.includes(pinSubcategoryQuery)
                      setPinned([...pinned, { subcategory: pinSubcategoryQuery, part_id: p.id, is_core: isCoreMatch }])
                      setPinSubcategoryDraft('')
                    }}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'#fff',
                      border:'none', borderBottom:'1px solid var(--slate-100)', textAlign:'left', cursor:'pointer', fontSize:12 }}>
                    <span style={{ fontFamily:'monospace', color:'var(--slate-700)' }}>{p.oem_part_number}</span>
                    <span style={{ color:'var(--slate-500)' }}>{p.name}</span>
                    {p.brand && <Badge tone="slate">{p.brand}</Badge>}
                  </button>
                ))}
              </div>
            )}
            {partsForPin && partsForPin.length === 0 && pinSubcategoryQuery && (
              <span style={{ fontSize:11, color:'var(--slate-400)' }}>No oem_parts with subcategory “{pinSubcategoryQuery}”.</span>
            )}
          </div>
        </Section>
      </div>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--slate-700)', textTransform:'uppercase', letterSpacing:'0.04em' }}>{title}</div>
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      <label style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>{label}</label>
      {children}
    </div>
  )
}

// ── main tab ────────────────────────────────────────────────────────────────

export const TabServiceParts = () => {
  const rows = useQuery(api.director_service_parts.listAllRules) as Row[] | undefined
  const usage = useQuery(api.director_service_parts.subcategoryUsage) as SubcategoryUsage | undefined
  const categories = useQuery(api.director_service_parts.serviceCategoriesList) as
    { id: Id<'service_categories'>; name: string }[] | undefined

  const [filter, setFilter] = useState<FilterKey>('all')
  const [modal, setModal] = useState<ModalMode | null>(null)

  const filtered = useMemo(() => {
    if (!rows) return []
    if (filter === 'all') return rows
    if (filter === 'unconfigured') return rows.filter(r => r.rule == null)
    return rows.filter(r => (r.rule?.parts_kind ?? r.service.parts_kind) === filter)
  }, [rows, filter])

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = {
      all: rows?.length ?? 0, labor_only: 0, per_axle: 0, per_cylinder: 0,
      per_unit_spec: 0, per_wheel: 0, fixed_kit: 0, unconfigured: 0,
    }
    for (const r of rows ?? []) {
      const k = (r.rule?.parts_kind ?? r.service.parts_kind) as PartsKind | null
      if (r.rule == null) c.unconfigured += 1
      if (k) c[k] += 1
    }
    return c
  }, [rows])

  return (
    <SectionAnchor
      id="serviceParts"
      title="Service Parts"
      subtitle="Director-editable parts rules per canonical service — subcategory allowlist, pinned OEM parts, qty override."
      right={(
        <Button variant="primary" onClick={() => setModal({ kind: 'create' })}>+ New service</Button>
      )}
    >
      {/* Filter chips */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:14 }}>
        {FILTERS.map(f => {
          const isActive = filter === f.key
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'5px 11px', borderRadius:999,
                fontSize:12, fontWeight:500, cursor:'pointer',
                background: isActive ? 'var(--slate-900)' : '#fff',
                color: isActive ? '#fff' : 'var(--slate-700)',
                border:`1px solid ${isActive ? 'var(--slate-900)' : 'var(--slate-200)'}` }}>
              {f.label}
              <span style={{ fontSize:11, opacity:0.7 }}>{counts[f.key]}</span>
            </button>
          )
        })}
      </div>

      {/* Table */}
      <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:12, overflow:'hidden' }}>
        <table style={tableStyles.table}>
          <thead>
            <tr>
              <th style={tableStyles.th}>Service</th>
              <th style={tableStyles.th}>Category</th>
              <th style={tableStyles.th}>Parts kind</th>
              <th style={tableStyles.th}>Unit</th>
              <th style={tableStyles.th}>Core</th>
              <th style={tableStyles.th}>As-needed</th>
              <th style={tableStyles.th}>Pinned</th>
              <th style={tableStyles.th}>Qty override</th>
              <th style={tableStyles.th}></th>
            </tr>
          </thead>
          <tbody>
            {rows === undefined && (
              <tr><td style={tableStyles.td} colSpan={9}>Loading…</td></tr>
            )}
            {rows && filtered.length === 0 && (
              <tr><td style={tableStyles.td} colSpan={9}>No services match this filter.</td></tr>
            )}
            {filtered.map(r => {
              const kind = (r.rule?.parts_kind ?? r.service.parts_kind) as PartsKind | null
              return (
                <tr key={String(r.service.id)}>
                  <td style={tableStyles.td}>
                    <div style={{ fontWeight:500, color:'var(--slate-900)' }}>{r.service.name}</div>
                    {r.service.slug && <div style={{ fontSize:11, color:'var(--slate-500)', fontFamily:'monospace' }}>{r.service.slug}</div>}
                  </td>
                  <td style={tableStyles.td}>{r.service.category_name ?? '—'}</td>
                  <td style={tableStyles.td}>
                    {kind ? <Badge tone={kindTone(kind)}>{kind}</Badge> : <Badge tone="red">unconfigured</Badge>}
                  </td>
                  <td style={tableStyles.td}>{r.rule?.parts_unit_label ?? r.service.parts_unit_label ?? '—'}</td>
                  <td style={tableStyles.td}>{r.rule?.core_subcategories.length ?? 0}</td>
                  <td style={tableStyles.td}>{r.rule?.as_needed_subcategories.length ?? 0}</td>
                  <td style={tableStyles.td}>{r.rule?.pinned_parts.length ?? 0}</td>
                  <td style={tableStyles.td}>{r.rule?.qty_override ?? '—'}</td>
                  <td style={tableStyles.td}>
                    <Button onClick={() => setModal({ kind: 'edit', row: r })}>Edit</Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Modal is conditionally mounted so each Edit/Create opens a fresh
          instance whose useState initializers pick up the row's rule data. */}
      {modal && (
        <PartsRuleModal
          key={modal.kind === 'edit' ? String(modal.row.service.id) : 'create'}
          mode={modal}
          onClose={() => setModal(null)}
          usage={usage}
          serviceCategories={categories ?? []}
        />
      )}
    </SectionAnchor>
  )
}

function kindTone(k: PartsKind): 'slate' | 'green' | 'yellow' | 'blue' | 'red' | 'purple' | 'indigo' | 'teal' | 'orange' {
  switch (k) {
    case 'labor_only':    return 'slate'
    case 'per_axle':      return 'blue'
    case 'per_cylinder':  return 'purple'
    case 'per_unit_spec': return 'teal'
    case 'per_wheel':     return 'indigo'
    case 'fixed_kit':     return 'green'
  }
}
