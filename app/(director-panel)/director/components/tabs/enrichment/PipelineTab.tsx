'use client'

// Tab · Pipeline — "how it works": the VIN → decode → Firecrawl scrape →
// Batch 1/2 → finalize data flow, the Firecrawl scraping sources, and the real
// batch system prompts (imported from the code via pipelineReference). Native
// panel styling.

import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '@/convex/_generated/api'
import { Badge } from '../../Primitives'
import { Panel, Empty, SkeletonBlock, fmtNum } from './helpers'

type Ref = FunctionReturnType<typeof api.directorEnrichment.pipelineReference>
type FlowNode = Ref['flow'][number]
type Step = Ref['llmSteps'][number]
type Source = Ref['firecrawl']['sources'][number]

const KIND_COLOR: Record<FlowNode['kind'], { bg: string; bd: string; fg: string }> = {
  input: { bg: 'var(--slate-100)', bd: 'var(--slate-200)', fg: 'var(--slate-700)' },
  decode: { bg: 'var(--blue-50)', bd: '#BFDBFE', fg: 'var(--blue-700)' },
  scrape: { bg: 'var(--teal-50)', bd: '#99F6E4', fg: 'var(--teal-700)' },
  llm: { bg: 'var(--green-50)', bd: '#A7F3D0', fg: 'var(--green-700)' },
  finalize: { bg: 'var(--slate-900)', bd: 'var(--slate-900)', fg: '#fff' },
}

/** Live in-flight counts per flow node, from real liveRuns stages. Each stage
 *  maps to exactly one node so counts are never double-attributed. */
function nodeLiveCounts(flow: FlowNode[], live: Array<{ status: string }> | undefined): number[] {
  if (!live || live.length === 0) return flow.map(() => 0)
  let llmSeen = 0
  return flow.map(n => {
    let statuses: string[] = []
    if (n.kind === 'decode') statuses = ['started']
    else if (n.kind === 'scrape') statuses = ['scraping']
    else if (n.kind === 'llm') { llmSeen++; statuses = llmSeen === 1 ? ['batch1'] : llmSeen === 2 ? ['batch2'] : [] }
    return statuses.length ? live.filter(r => statuses.includes(r.status)).length : 0
  })
}

function FlowDiagram({ flow, live }: { flow: FlowNode[]; live: Array<{ status: string }> | undefined }) {
  const counts = nodeLiveCounts(flow, live)
  const totalLive = (live ?? []).length
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, overflowX: 'auto', paddingBottom: 4 }}>
      {flow.map((n, i) => {
        const c = KIND_COLOR[n.kind]
        const count = counts[i]
        return (
          <div key={n.id} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ width: 168, minWidth: 168, alignSelf: 'stretch', background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: c.fg }}>{n.label}</div>
                {count > 0 && (
                  <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: c.fg, whiteSpace: 'nowrap' }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: c.fg, animation: 'omPulse 1.4s ease-in-out infinite' }} />
                    {count} live
                  </span>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, color: n.kind === 'finalize' ? 'var(--slate-300)' : 'var(--slate-600)' }}>{n.detail}</div>
            </div>
            {i < flow.length - 1 && (
              <div style={{ width: 26, minWidth: 26, height: 2, alignSelf: 'center', margin: '0 6px', borderRadius: 2,
                background: totalLive > 0 ? 'linear-gradient(90deg, transparent, var(--blue-500), transparent)' : 'var(--slate-200)',
                backgroundSize: '200% 100%', animation: totalLive > 0 ? 'omFlow 1.1s linear infinite' : 'none' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function modelTone(model: string | null): 'blue' | 'purple' | 'slate' {
  if (!model) return 'slate'
  return model.includes('Haiku') ? 'purple' : 'blue'
}

function StepCard({ s }: { s: Step }) {
  return (
    <div style={{ border: '1px solid var(--slate-200)', borderRadius: 10, background: '#fff', padding: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--slate-900)' }}>{s.title}</span>
        {s.model && <Badge tone={modelTone(s.model)}>{s.model}</Badge>
        }
        {s.maxTokens != null && <Badge tone="slate">{fmtNum(s.maxTokens)} max tok</Badge>}
        <Badge tone={s.webSearch === 'none' ? 'slate' : 'green'}>
          {s.webSearch === 'none' ? 'no web search' : `web search · ${s.webSearch}`}
        </Badge>
      </div>
      <div style={{ marginTop: 8, fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.5 }}>{s.purpose}</div>

      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Prompt inputs</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {s.inputs.map((inp, i) => (
            <span key={i} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'var(--slate-50)', border: '1px solid var(--slate-100)', color: 'var(--slate-600)' }}>{inp}</span>
          ))}
        </div>
      </div>

      {s.systemPrompt && (
        <details style={{ marginTop: 10, border: '1px solid var(--slate-200)', borderRadius: 8, background: 'var(--slate-50)' }}>
          <summary style={{ cursor: 'pointer', userSelect: 'none', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--slate-600)' }}>
            System prompt <span style={{ fontWeight: 400, color: 'var(--slate-400)' }}>({fmtNum(s.systemPrompt.length)} chars)</span>
          </summary>
          <pre style={{ maxHeight: 360, overflow: 'auto', borderTop: '1px solid var(--slate-200)', background: '#fff', padding: '10px 12px', fontSize: 12, lineHeight: 1.55, color: 'var(--slate-700)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>
            {s.systemPrompt}
          </pre>
        </details>
      )}
    </div>
  )
}

function SourceCard({ s }: { s: Source }) {
  return (
    <div style={{ border: '1px solid var(--slate-200)', borderRadius: 10, background: '#fff', padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-900)' }}>{s.category}</div>
      <div style={{ marginTop: 3, fontSize: 11, fontWeight: 500, color: 'var(--blue-700)' }} className="mono">{s.method}</div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--slate-600)', lineHeight: 1.5 }}>{s.detail}</div>
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {s.examples.map((ex, i) => (
          <span key={i} className="mono" style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 6, background: 'var(--slate-50)', border: '1px solid var(--slate-100)', color: 'var(--slate-600)' }}>{ex}</span>
        ))}
      </div>
    </div>
  )
}

export function PipelineTab({ token }: { token: string }) {
  const ref = useQuery(api.directorEnrichment.pipelineReference, { token })
  const live = useQuery(api.directorEnrichment.liveRuns, { token })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Pipeline flow" sub={live && live.length > 0 ? `${live.length} in flight` : 'VIN → normalized catalog'}>
        {!ref ? <SkeletonBlock height={110} /> : <FlowDiagram flow={ref.flow} live={live} />}
      </Panel>

      <Panel title="Web scraping · Firecrawl" sub="how sources become prompt context">
        {!ref ? <SkeletonBlock height={200} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
              {ref.firecrawl.sources.map(s => <SourceCard key={s.category} s={s} />)}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Blocked domains</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {ref.firecrawl.blockedDomains.map(d => <Badge key={d} tone="red">{d}</Badge>)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 10, marginBottom: 6 }}>Never-valid price sources (marketplaces):</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {ref.firecrawl.marketplaceDomains.map(d => <Badge key={d} tone="orange">{d}</Badge>)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Caching</div>
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--slate-600)', lineHeight: 1.6 }}>
                  {ref.firecrawl.caching.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 8px' }}>Size caps</div>
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--slate-600)', lineHeight: 1.6 }}>
                  {ref.firecrawl.charCaps.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--slate-400)', lineHeight: 1.5, borderTop: '1px solid var(--slate-100)', paddingTop: 12 }}>
              <b>Metering:</b> {ref.firecrawl.metering}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="LLM prompts" sub="the real batch system prompts (in sync with the code)">
        {!ref ? <SkeletonBlock height={240} /> : ref.llmSteps.length === 0 ? <Empty>No prompt reference available.</Empty> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {ref.llmSteps.map(s => <StepCard key={s.id} s={s} />)}
            <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>
              These are the <i>templates</i>. To see a real, fully-filled prompt (with the scraped markdown and the exact fields asked) for a specific run, open <b>Deep-Dive → Pipeline trace</b> and expand a batch step's Request.
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}
