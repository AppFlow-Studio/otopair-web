'use client'

// Generic collapsible JSON tree — formatted alternative to dumping trace
// request/response payloads as flat `<pre>` text. Renders nesting via
// indentation + a connector line so parent/child relations in the payload
// are visually obvious, not just implied by brace-matching. Field names are
// humanized (camelCase/snake_case → "Title Case") and enrichment's
// ubiquitous `{ value, source_url, confidence, flagged }` field-result shape
// gets a compact, plain-language row instead of a 4-line nested tree — this
// view is read by directors, not just engineers, so it favors "Oil
// Viscosity: 5W-30 (92% · example.com)" over raw key/value nesting.

import { useState, type CSSProperties } from 'react'
import { fmtNum } from './helpers'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

const LONG_STRING = 240
const URL_RE = /^https?:\/\//
const TRUNCATION_TRAILER_RE = /\n\n…\[truncated \d+ chars\]$/

/** Best-effort recovery for text truncated by runSteps.ts's `cap()`, which
 *  always keeps a valid JSON PREFIX (`slice(0, N)` of the original
 *  `JSON.stringify` output) plus a trailing "…[truncated N chars]" marker —
 *  never arbitrary corruption. Strips that marker, closes any string left
 *  open at the cut point, drops a dangling trailing comma, then closes any
 *  open objects/arrays in LIFO order. Only called after an exact
 *  `JSON.parse` already failed; never fabricates values, only closes
 *  structure around real prefix data. Returns `null` if the result still
 *  isn't valid JSON (e.g. the cut landed mid-key, before a value). */
export function tryParseJsonPrefix(raw: string): Json | null {
  const text = raw.replace(TRUNCATION_TRAILER_RE, '')
  let inString = false
  let escaped = false
  const stack: ('{' | '[')[] = []
  for (const c of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') stack.pop()
  }
  let out = inString ? `${text}"` : text.replace(/,\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  try { return JSON.parse(out) } catch { return null }
}

// ─── key humanization ──────────────────────────────────────────────────────

/** Acronyms that should stay upper-cased rather than title-cased. */
const ACRONYMS = new Set(['id', 'vin', 'oem', 'msrp', 'url', 'urls', 'nhtsa', 'vdb', 'ps', 'cca', 'rpo', 'ymmt', 'usd', 'qts', 'oz'])

/** Exact-key overrides for fields whose plain-English meaning isn't obvious
 *  from splitting the identifier alone. Anything not listed here still gets
 *  a reasonable label from the generic camelCase/snake_case splitter below. */
const KEY_OVERRIDES: Record<string, string> = {
  system: 'System instructions',
  userPrompt: 'Prompt sent to the AI',
  rawText: 'Raw AI output',
  data: 'Extracted data',
  customId: 'Request ID',
  costUsd: 'Cost (USD)',
  tokensIn: 'Input tokens',
  tokensOut: 'Output tokens',
  webSearches: 'Web searches used',
  maxTokens: 'Max tokens',
  maxSearchUses: 'Max web searches',
  nhtsa_merged_identity: 'NHTSA decoded data',
  vdb_fields: 'VIN database fields',
  parts_source_urls: 'Parts catalog sources',
  manual_source_urls: "Owner's manual sources",
}

/** "tokensIn" → "Input Tokens" style humanization: split camelCase/snake_case
 *  into words, upper-case known acronyms, title-case the rest. Falls back to
 *  this for any key not covered by KEY_OVERRIDES, so unfamiliar fields added
 *  later still render readably instead of raw identifier text. */
function humanizeKey(key: string): string {
  if (key in KEY_OVERRIDES) return KEY_OVERRIDES[key]
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return key
  return words
    .map(w => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
}

function hostnameOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

function UrlLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={url}
      style={{ fontSize: 12, color: 'var(--blue-600)', textDecoration: 'none', wordBreak: 'break-word' }}>
      {hostnameOf(url) ?? url} ↗
    </a>
  )
}

const miniBtnStyle: CSSProperties = {
  border: 'none', background: 'none', padding: '0 0 0 6px', margin: 0, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 11, fontWeight: 500, color: 'var(--blue-600)',
}

function StringLeaf({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (URL_RE.test(text)) return <UrlLink url={text} />
  if (text.length <= LONG_STRING) {
    return <span style={{ color: 'var(--slate-800)', wordBreak: 'break-word' }}>{text}</span>
  }
  return (
    <span>
      <span style={{ color: 'var(--slate-800)', whiteSpace: open ? 'pre-wrap' : 'nowrap', wordBreak: 'break-word' }}>
        {open ? text : text.slice(0, LONG_STRING) + '…'}
      </span>
      <button type="button" onClick={e => { e.stopPropagation(); setOpen(o => !o) }} style={miniBtnStyle}>
        {open ? 'Show less' : `Show full text (${fmtNum(text.length)} characters)`}
      </button>
    </span>
  )
}

function LeafValue({ value }: { value: Exclude<Json, object | Json[]> }) {
  if (value === null) return <span style={{ color: 'var(--slate-400)', fontStyle: 'italic' }}>Not set</span>
  if (typeof value === 'string') return <StringLeaf text={value} />
  if (typeof value === 'number') return <span style={{ color: 'var(--slate-800)', fontWeight: 500 }}>{value.toLocaleString('en-US')}</span>
  if (typeof value === 'boolean') return <span style={{ color: 'var(--slate-800)', fontWeight: 500 }}>{value ? 'Yes' : 'No'}</span>
  return <span style={{ color: 'var(--slate-400)' }}>{String(value)}</span>
}

function Chevron({ open }: { open: boolean }) {
  return <span style={{ display: 'inline-block', width: 12, color: 'var(--slate-400)', fontSize: 10 }}>{open ? '▾' : '▸'}</span>
}

function isContainer(v: Json): v is Json[] | { [k: string]: Json } {
  return v !== null && typeof v === 'object'
}

function entriesOf(value: Json[] | { [k: string]: Json }): [string, Json][] {
  return Array.isArray(value) ? value.map((v, i) => [String(i), v] as [string, Json]) : Object.entries(value)
}

// ─── enrichment "field result" shape ───────────────────────────────────────
// The pipeline's near-universal shape for an extracted spec/part/fluid field:
// { value, source_url, source_type, confidence, flagged, flag_reason }. It
// shows up dozens of times per batch response, and as a generic tree each
// instance is a 4-6 line expandable node — unreadable at a glance. Rendered
// instead as one line: the value, plus confidence/source/flag as small
// inline badges, with the raw record still one click away.

type FieldResult = { [k: string]: Json }

function isFieldResultLike(v: Json): v is FieldResult {
  if (!isContainer(v) || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.includes('value') && (keys.includes('source_url') || keys.includes('confidence') || keys.includes('source_type') || keys.includes('flagged'))
}

function confidenceTone(pct: number): { fg: string; bg: string } {
  if (pct >= 85) return { fg: 'var(--green-700)', bg: 'var(--green-50)' }
  if (pct >= 60) return { fg: 'var(--yellow-800)', bg: 'var(--yellow-50)' }
  return { fg: 'var(--red-700)', bg: 'var(--red-50)' }
}

function fieldValueText(value: Json): string {
  if (value === null || value === undefined) return 'Not found'
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'number') return value.toLocaleString('en-US')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function FieldResultRow({ label, record }: { label: string | null; record: FieldResult }) {
  const [expanded, setExpanded] = useState(false)
  const value = record.value ?? null
  const sourceUrl = typeof record.source_url === 'string' ? record.source_url : null
  const sourceType = typeof record.source_type === 'string' ? record.source_type : null
  const confidenceRaw = typeof record.confidence === 'number' ? record.confidence : null
  const confidencePct = confidenceRaw != null ? Math.round(confidenceRaw <= 1 ? confidenceRaw * 100 : confidenceRaw) : null
  const flagged = record.flagged === true
  const flagReason = typeof record.flag_reason === 'string' ? record.flag_reason : null
  const isEmpty = value === null || value === undefined

  return (
    <div style={{ padding: '4px 0' }}>
      <div onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 7, cursor: 'pointer' }}>
        {label != null && <span style={{ color: 'var(--slate-600)', fontWeight: 600, fontSize: 13 }}>{label}</span>}
        <span style={{ fontSize: 13, color: isEmpty ? 'var(--slate-400)' : 'var(--slate-900)', fontStyle: isEmpty ? 'italic' : 'normal' }}>
          {fieldValueText(value)}
        </span>
        {confidencePct != null && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, ...confidenceTone(confidencePct) }}>
            {confidencePct}% confident
          </span>
        )}
        {flagged && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--red-700)' }}>⚑ Flagged</span>}
        {sourceUrl && <UrlLink url={sourceUrl} />}
        {!sourceUrl && sourceType && <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>via {sourceType.replace(/_/g, ' ')}</span>}
        <span style={{ fontSize: 10, color: 'var(--slate-300)' }}>{expanded ? 'hide detail' : 'show detail'}</span>
      </div>
      {expanded && (
        <div style={{ marginLeft: 6, paddingLeft: 10, marginTop: 4, borderLeft: '1px solid var(--slate-200)' }}>
          {flagReason && <div style={{ fontSize: 12, color: 'var(--orange-700)', marginBottom: 3 }}>Flag reason: {flagReason}</div>}
          {Object.entries(record).map(([k, v]) => (
            <TreeNode key={k} label={humanizeKey(k)} value={v} depth={0} defaultDepth={0} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── generic tree node ──────────────────────────────────────────────────────

const rowStyle: CSSProperties = { fontSize: 13, lineHeight: 1.8 }

function TreeNode({ label, value, depth, defaultDepth }: {
  label: string | null; value: Json; depth: number; defaultDepth: number
}) {
  const [open, setOpen] = useState(depth < defaultDepth)

  if (isFieldResultLike(value)) return <FieldResultRow label={label} record={value} />

  if (!isContainer(value)) {
    return (
      <div style={rowStyle}>
        {label != null && <span style={{ color: 'var(--slate-600)', fontWeight: 600 }}>{label}: </span>}
        <LeafValue value={value} />
      </div>
    )
  }

  const isArray = Array.isArray(value)
  const entries = entriesOf(value)

  if (entries.length === 0) {
    return (
      <div style={rowStyle}>
        {label != null && <span style={{ color: 'var(--slate-600)', fontWeight: 600 }}>{label}: </span>}
        <span style={{ color: 'var(--slate-400)', fontStyle: 'italic' }}>{isArray ? 'No items' : 'Nothing here'}</span>
      </div>
    )
  }

  const countLabel = isArray ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : `${entries.length} field${entries.length === 1 ? '' : 's'}`

  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', padding: '3px 0',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, textAlign: 'left', width: '100%' }}>
        <Chevron open={open} />
        {label != null && <span style={{ color: 'var(--slate-600)', fontWeight: 600 }}>{label}</span>}
        <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>{countLabel}</span>
      </button>
      {open && (
        <div style={{ marginLeft: 6, paddingLeft: 12, borderLeft: '1px solid var(--slate-200)' }}>
          {entries.map(([k, v]) => (
            <TreeNode key={k} label={isArray ? `Item ${Number(k) + 1}` : humanizeKey(k)} value={v} depth={depth + 1} defaultDepth={defaultDepth} />
          ))}
        </div>
      )}
    </div>
  )
}

const treeActionBtnStyle: CSSProperties = {
  border: 'none', background: 'none', padding: '2px 6px', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 11, fontWeight: 500, color: 'var(--slate-400)',
}

/** Formatted, collapsible view of a parsed JSON value — plain-language field
 *  labels and no JSON punctuation, so it reads as a document rather than
 *  code. Top-level entries default open; anything nested deeper starts
 *  collapsed so large `data` blobs don't dump 50+ fields on first render. */
export function JsonTree({ value, defaultDepth = 1 }: { value: Json; defaultDepth?: number }) {
  const [resetKey, setResetKey] = useState(0)
  const [depth, setDepth] = useState(defaultDepth)

  if (!isContainer(value)) return <TreeNode label={null} value={value} depth={0} defaultDepth={depth} />

  const entries = entriesOf(value)
  const isArray = Array.isArray(value)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 4 }}>
        <button type="button" style={treeActionBtnStyle} onClick={() => { setDepth(Infinity); setResetKey(k => k + 1) }}>Expand all</button>
        <span style={{ color: 'var(--slate-200)' }}>|</span>
        <button type="button" style={treeActionBtnStyle} onClick={() => { setDepth(0); setResetKey(k => k + 1) }}>Collapse all</button>
      </div>
      <div key={resetKey}>
        {entries.map(([k, v]) => (
          <TreeNode key={k} label={isArray ? `Item ${Number(k) + 1}` : humanizeKey(k)} value={v} depth={0} defaultDepth={depth} />
        ))}
      </div>
    </div>
  )
}
