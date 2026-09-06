'use client'

// ⌘K global search for the director panel. Fuzzy-jumps between the 28 director
// tabs (via @nozbe/microfuzz) and searches users / shops / bookings through the
// gated portalSearch.search query, deep-linking each record into its tab with
// gotoEntity. Nav is instant/in-memory; records are debounced + networked.

import { useCallback, useContext, useEffect, useState } from 'react'
import { Command } from 'cmdk'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useFuzzySearchList, Highlight } from '@nozbe/microfuzz/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from './DirectorSessionCtx'
import { gotoEntity } from './directorNav'
import { NAV_GROUPS, NAV_ITEMS, type NavItem } from './navConfig'

const RECORDS_DEBOUNCE_MS = 180

type NavRow = NavItem & { section: string }

const HIGHLIGHT_STYLE = { background: 'transparent', color: '#2563eb', fontWeight: 600 }

// Shared cmdk group-heading treatment so every section header (nav + records)
// renders identically.
const GROUP_HEADING_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-slate-400'

// `settings` lives at the tail of NAV_ITEMS (sidebar footer gear, not a group).
const SETTINGS_ITEM = NAV_ITEMS.find((i) => i.id === 'settings')

export function DirectorCommandK({
  open,
  onOpenChange,
  onNavigateTab,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNavigateTab: (id: string) => void
}) {
  const token = useContext(DirectorSessionCtx)?.token ?? ''
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')

  // Reset on close so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebounced('')
    }
  }, [open])

  // Only the (networked) record search waits for the debounce; nav stays instant.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), RECORDS_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // ── Navigation (in-memory fuzzy over the tab index) ───────────────────────
  const getText = useCallback(
    (item: NavRow) => [item.label, item.section, ...(item.keywords ?? [])],
    [],
  )
  const mapResultItem = useCallback(
    ({ item, matches }: { item: NavRow; matches: Array<Array<[number, number]> | null> }) => ({
      item,
      ranges: matches[0] ?? null,
    }),
    [],
  )
  const navResults = useFuzzySearchList({
    list: NAV_ITEMS as NavRow[],
    queryText: query,
    getText,
    mapResultItem,
    // 'aggressive' gives the typo-tolerance ("invntry" → Inventory) that 'smart'
    // rejects as too poor a match.
    strategy: 'aggressive',
  })

  // ── Records (debounced, gated server query) ───────────────────────────────
  const recordsEnabled = open && !!token && debounced.length >= 2
  const records = useQuery(
    api.portalSearch.search,
    recordsEnabled ? { token, q: debounced } : 'skip',
  ) as FunctionReturnType<typeof api.portalSearch.search> | undefined

  const users = records?.users ?? []
  const shops = records?.shops ?? []
  const bookings = records?.bookings ?? []
  const hasRecords = users.length > 0 || shops.length > 0 || bookings.length > 0
  const recordsLoading = recordsEnabled && records === undefined
  const searching = query.trim().length > 0
  const noResults = searching && navResults.length === 0 && !hasRecords && !recordsLoading

  const goTab = (id: string) => {
    onOpenChange(false)
    onNavigateTab(id)
  }
  const goRecord = (tab: string, id: string) => {
    onOpenChange(false)
    gotoEntity(tab, id)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-slate-950/50 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-24 z-[100] w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-slate-900/10 focus:outline-none">
          <Dialog.Title className="sr-only">Director search</Dialog.Title>
          <Command shouldFilter={false} label="Director search">
            <Command.Input
              value={query}
              onValueChange={setQuery}
              autoFocus
              placeholder="Jump to a page, or search users, shops, bookings…"
              className="w-full border-b border-slate-100 px-4 py-3.5 text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
            />
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              {noResults && (
                <Command.Empty className="px-3 py-8 text-center text-[13px] text-slate-400">
                  No matches for &ldquo;{query.trim()}&rdquo;.
                </Command.Empty>
              )}

              {/* Idle state: the full nav, grouped by section like the sidebar —
                  scannable instead of a flat wall of 28 rows. */}
              {!searching &&
                NAV_GROUPS.map((group, i) => (
                  <Command.Group
                    key={group.section ?? `group-${i}`}
                    heading={group.section}
                    className={GROUP_HEADING_CLASS}
                  >
                    {group.items.map((item) => (
                      <NavItemRow key={item.id} item={item} onSelect={() => goTab(item.id)} />
                    ))}
                  </Command.Group>
                ))}
              {!searching && SETTINGS_ITEM && (
                <Command.Group heading="System" className={GROUP_HEADING_CLASS}>
                  <NavItemRow item={SETTINGS_ITEM} onSelect={() => goTab(SETTINGS_ITEM.id)} />
                </Command.Group>
              )}

              {/* While searching: one relevance-ranked list, section shown per row. */}
              {searching && navResults.length > 0 && (
                <Command.Group heading="Pages" className={GROUP_HEADING_CLASS}>
                  {navResults.map(({ item, ranges }) => (
                    <NavItemRow key={item.id} item={item} ranges={ranges} showSection onSelect={() => goTab(item.id)} />
                  ))}
                </Command.Group>
              )}

              {recordsLoading && (
                <div className="px-3 py-4 text-center text-[12px] text-slate-400">Searching records…</div>
              )}

              {users.length > 0 && (
                <RecordGroup heading="Users">
                  {users.map((u) => (
                    <RecordItem key={u.id} value={`user-${u.id}`} primary={u.label} secondary={u.sub} onSelect={() => goRecord('users', u.id)} />
                  ))}
                </RecordGroup>
              )}
              {shops.length > 0 && (
                <RecordGroup heading="Shops">
                  {shops.map((s) => (
                    <RecordItem key={s.id} value={`shop-${s.id}`} primary={s.label} secondary={s.sub} onSelect={() => goRecord('shops', s.id)} />
                  ))}
                </RecordGroup>
              )}
              {bookings.length > 0 && (
                <RecordGroup heading="Bookings">
                  {bookings.map((b) => (
                    <RecordItem key={b.id} value={`booking-${b.id}`} primary={b.label} secondary={b.sub} onSelect={() => goRecord('bookings', b.id)} />
                  ))}
                </RecordGroup>
              )}
            </Command.List>
            <div className="flex items-center gap-3 border-t border-slate-100 px-3 py-2 text-[11px] text-slate-400">
              <span><kbd className="rounded bg-slate-100 px-1 font-mono text-slate-500">↑↓</kbd> navigate</span>
              <span><kbd className="rounded bg-slate-100 px-1 font-mono text-slate-500">↵</kbd> open</span>
              <span><kbd className="rounded bg-slate-100 px-1 font-mono text-slate-500">esc</kbd> close</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// One nav row. `ranges` highlights the fuzzy match while searching; `showSection`
// appends the section tag (only useful in the flat, ranked search view — the
// idle view already carries a section heading above each group).
function NavItemRow({
  item,
  ranges,
  showSection,
  onSelect,
}: {
  item: NavItem & { section?: string }
  ranges?: Array<[number, number]> | null
  showSection?: boolean
  onSelect: () => void
}) {
  const Icon = item.Icon
  return (
    <Command.Item
      value={`nav-${item.id}`}
      onSelect={onSelect}
      className="group flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] text-slate-800 data-[selected=true]:bg-blue-50"
    >
      <span className="shrink-0 text-slate-400 group-data-[selected=true]:text-blue-500">
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">
        {ranges ? <Highlight text={item.label} ranges={ranges} style={HIGHLIGHT_STYLE} /> : item.label}
      </span>
      {showSection && item.section && <span className="shrink-0 text-[11px] text-slate-400">{item.section}</span>}
    </Command.Item>
  )
}

function RecordGroup({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group heading={heading} className={GROUP_HEADING_CLASS}>
      {children}
    </Command.Group>
  )
}

function RecordItem({ value, primary, secondary, onSelect }: { value: string; primary: string; secondary: string; onSelect: () => void }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-3 py-2 text-[13px] text-slate-800 data-[selected=true]:bg-blue-50"
    >
      <span className="min-w-0 truncate font-medium">{primary}</span>
      {secondary && <span className="shrink-0 text-[12px] text-slate-400">{secondary}</span>}
    </Command.Item>
  )
}
