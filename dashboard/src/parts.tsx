import { useEffect, useState } from 'react'
import { api, errText } from './api'
import type { CapabilityDetail, Decision, Job, Kind, Memory, MemoryKind, NewCapability, Observation, PromptItem, Summary, WorkflowStep } from './types'
import { Segmented, colorOf, fmtDay, fmtMs, fmtTime } from './ui'

export const resultTag = (d: Decision) =>
  d.abstained ? <span className="tag">abstained</span> : d.followed ? <span className="tag good">followed</span> : <span className="tag warn">ignored</span>

export function DecisionTable({ rows, projects, onOpen }: { rows: Decision[]; projects: string[]; onOpen?: (d: Decision) => void }) {
  return (
    <table>
      <thead><tr><th>Prompt</th><th>Suggested</th><th>Result</th><th className="num">Latency</th></tr></thead>
      <tbody>
        {rows.map(d => (
          <tr key={d.id} className={onOpen ? 'click' : ''} onClick={() => onOpen?.(d)}>
            <td>
              <div className="title">{d.prompt}</div>
              <div className="subline">{d.project} · {fmtTime(d.at)} · {d.model_tier}</div>
              <div className="bar" style={{ width: `${Math.round(d.confidence * 60)}%`, background: colorOf(projects, d.project) }} />
            </td>
            <td>{d.steps.slice(0, 2).map(s => <span key={s.cap_id} className="tag">{s.invoke}</span>)}{d.steps.length > 2 && <span className="faint">+{d.steps.length - 2}</span>}</td>
            <td>{resultTag(d)}</td>
            <td className="num">{fmtMs(d.latency_ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function DecisionDetail({ d, onDeleted }: { d: Decision; onDeleted: (id: number) => void }) {
  const [err, setErr] = useState('')
  const remove = async () => {
    if (!confirm('Delete this stored prompt? It is removed from claudethecaller for good.')) return
    try { await api.deleteDecision(d.id); onDeleted(d.id) } catch (e) { setErr(errText(e)) }
  }
  return (
    <>
      <div>
        <div className="card-sub">{d.project} · {fmtTime(d.at)} · session {d.session_id}</div>
        <h2 style={{ margin: '6px 0 0', fontSize: 18 }}>{d.prompt}</h2>
      </div>
      <div>
        <span className="tag">{d.source === 'history' ? 'from history · intent' : 'live'}</span><span className="tag">{d.difficulty}</span><span className="tag">model: {d.model_tier}</span>
        <span className="tag">confidence {d.confidence.toFixed(2)}</span><span className="tag">{fmtMs(d.latency_ms)}</span>{resultTag(d)}
      </div>
      <div className="card-title">Bundle</div>
      {d.steps.length ? (
        <div className="steps">
          {d.steps.map(s => (
            <div key={s.order} className="step">
              <div className="n">{s.order}</div>
              <div>
                <div className="title mono">{s.invoke} <span className="tag">{s.kind}</span>{s.agent && <span className="tag">agent: {s.agent}</span>}</div>
                <div className="subline">{s.reason}</div>
              </div>
            </div>
          ))}
        </div>
      ) : <div className="empty">Router abstained: no capability scored above the threshold.</div>}
      <div className="card-title">Why these (search stages)</div>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Capability</th><th className="num">Dense</th><th className="num">Keyword</th><th className="num">RRF</th><th className="num">Rerank</th></tr></thead>
          <tbody>
            {d.stages.map(r => (
              <tr key={r.cap_id}>
                <td><span className="mono">{r.cap_id}</span>{r.dropped && <div className="subline">dropped: {r.dropped}</div>}</td>
                <td className="num">{r.dense_rank ?? '—'}</td><td className="num">{r.sparse_rank ?? '—'}</td>
                <td className="num">{r.rrf.toFixed(4)}</td><td className="num">{r.rerank?.toFixed(2) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions"><button className="btn danger" onClick={remove}>Delete this prompt</button>{err && <span className="err">{err}</span>}</div>
    </>
  )
}

const MEMORY_KINDS: MemoryKind[] = ['preference', 'convention', 'fact', 'skill_outcome']

/** One memory: pin, edit (text, kind, project → global), soft delete with Undo, supersede history. */
export function MemoryCard({ m, onChange }: { m: Memory; onChange: (m: Memory) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ text: m.text, kind: m.kind, scope: m.scope })
  const [history, setHistory] = useState<Memory[] | null>(null)
  const [err, setErr] = useState('')
  const run = async (fn: () => Promise<void>) => { try { await fn(); setErr('') } catch (e) { setErr(errText(e)) } }

  if (m.deleted_at) return (
    <div className="card pad mem undo">
      <span><span className="tag bad">deleted</span> {m.text.slice(0, 60)}{m.text.length > 60 ? '…' : ''}</span>
      <button className="btn" onClick={() => run(async () => onChange(await api.restoreMemory(m.id)))}>Undo</button>
      {err && <div className="err">{err}</div>}
    </div>
  )
  return (
    <div className="card pad mem">
      <div>
        <span className="tag">{m.kind.replace('_', ' ')}</span>
        <span className="tag">{m.scope === 'global' ? 'global' : m.project}</span>
        {m.pinned && <span className="tag good">pinned</span>}
      </div>
      {editing ? (
        <div className="form">
          <textarea value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} autoFocus />
          <div className="row2">
            <label>Kind<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as MemoryKind })}>{MEMORY_KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
            {/* ponytail: PATCH has no `project`, so a global memory can't be moved into a project yet (reported). */}
            <label>Scope<select value={draft.scope} disabled={m.scope === 'global'} onChange={e => setDraft({ ...draft, scope: e.target.value as Memory['scope'] })}>
              <option value="project">project</option><option value="global">global</option></select></label>
          </div>
        </div>
      ) : <div>{m.text}</div>}
      {m.supersedes && <div className="subline">replaces {m.supersedes}</div>}
      {history && (
        <div className="history">
          {history.length ? history.map(h => <div key={h.id}><span className="mono faint">{h.id} · {fmtDay(h.updated_at)}</span> {h.text}</div>) : <span>No earlier versions.</span>}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="mem-meta">
        <span className="mono">conf {m.confidence.toFixed(2)}</span>
        <span className="mono">used {m.use_count}×</span>
        <span title={m.source}>{fmtDay(m.updated_at)} · {m.source}</span>
      </div>
      <div className="actions">
        {editing ? (
          <>
            <button className="btn" onClick={() => run(async () => { onChange(await api.updateMemory(m.id, draft)); setEditing(false) })}>Save</button>
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => run(async () => onChange(await api.updateMemory(m.id, { pinned: !m.pinned })))}>{m.pinned ? 'Unpin' : 'Pin'}</button>
            <button className="btn" onClick={() => run(async () => setHistory(history ? null : (await api.memory(m.id)).history))}>History</button>
            <button className="btn" onClick={() => { setDraft({ text: m.text, kind: m.kind, scope: m.scope }); setEditing(true) }}>Edit</button>
            <button className="btn danger" onClick={() => run(async () => { await api.deleteMemory(m.id); onChange({ ...m, deleted_at: new Date().toISOString() }) })}>Delete</button>
          </>
        )}
      </div>
    </div>
  )
}

// Adapted from claude-mem 15.2.1 (Apache-2.0, © 2026 Alex Newman): src/ui/viewer/components/{ObservationCard,SummaryCard,PromptCard}.tsx and src/ui/icon-thick-*.svg. Changes: our types and tokens, soft delete with Undo, no source badges, icons inlined with integer coordinates.

/** The soft-deleted stub of an observation or summary: same Undo pattern as MemoryCard. */
function Deleted({ label, onUndo }: { label: string; onUndo: () => Promise<void> }) {
  const [err, setErr] = useState('')
  return (
    <div className="card pad mem undo">
      <span><span className="tag bad">deleted</span> {label.slice(0, 60)}{label.length > 60 ? '…' : ''}</span>
      <button className="btn" onClick={async () => { try { await onUndo(); setErr('') } catch (e) { setErr(errText(e)) } }}>Undo</button>
      {err && <div className="err">{err}</div>}
    </div>
  )
}

/** One observation: facts and narrative toggle (never both), concepts and files under facts, soft delete with Undo. `compact` is for the session drawer. */
export function ObservationCard({ o, onChange, compact }: { o: Observation; onChange: (o: Observation) => void; compact?: boolean }) {
  const [view, setView] = useState<'facts' | 'narrative' | null>(null)
  const [err, setErr] = useState('')
  if (o.deleted_at) return <Deleted label={o.title} onUndo={async () => onChange(await api.obsRestore(o.id))} />
  const hasFacts = o.facts.length > 0 || o.concepts.length > 0 || o.files_read.length > 0 || o.files_modified.length > 0
  const toggle = (v: 'facts' | 'narrative') => setView(view === v ? null : v)
  const remove = async () => {
    try { await api.obsDelete(o.id); onChange({ ...o, deleted_at: new Date().toISOString() }) } catch (e) { setErr(errText(e)) }
  }
  return (
    <div className={'card pad obs-card' + (compact ? ' compact' : '')}>
      <div className="fc-head">
        <div><span className="badge obs-badge">{o.type.replace('_', ' ')}</span>{!compact && <span className="tag">{o.project}</span>}</div>
        <div className="fc-tools">
          {hasFacts && <button className={'vmt' + (view === 'facts' ? ' on' : '')} aria-pressed={view === 'facts'} onClick={() => toggle('facts')}>facts</button>}
          {o.narrative && <button className={'vmt' + (view === 'narrative' ? ' on' : '')} aria-pressed={view === 'narrative'} onClick={() => toggle('narrative')}>narrative</button>}
          <button className="vmt del" onClick={remove}>delete</button>
        </div>
      </div>
      <h3 className="fc-title">{o.title || 'Untitled'}</h3>
      {view === null && o.subtitle && <div className="fc-sub">{o.subtitle}</div>}
      {view === 'facts' && o.facts.length > 0 && <ul className="fc-facts">{o.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}
      {view === 'narrative' && <div className="fc-narr">{o.narrative}</div>}
      {view === 'facts' && (o.concepts.length > 0 || o.files_read.length > 0 || o.files_modified.length > 0) && (
        <div className="fc-files">
          {o.concepts.map((c, i) => <span key={i} className="cchip">{c}</span>)}
          {o.files_read.length > 0 && <span className="mono"><b>read:</b> {o.files_read.join(', ')}</span>}
          {o.files_modified.length > 0 && <span className="mono"><b>modified:</b> {o.files_modified.join(', ')}</span>}
        </div>
      )}
      <div className="fc-foot mono">#{o.id} • {fmtTime(o.created_at)}</div>
      {err && <div className="err">{err}</div>}
    </div>
  )
}

// The five section icons, inlined from claude-mem's SVGs with integer coordinates (they render at 14 px); `notes` is stroked, the rest filled.
const SUM_ICONS: Record<string, { vb: string; fill?: string[]; stroke?: [string, number][] }> = {
  investigated: { vb: '0 0 295 339', fill: ['M 229 225 C 216 231 202 235 187 234 C 178 233 169 234 161 238 C 146 244 131 242 115 240 C 110 239 103 239 98 240 C 91 241 90 246 94 252 C 108 269 104 290 83 299 C 76 302 68 303 60 305 C 50 307 43 311 39 321 C 37 325 33 329 30 333 C 25 338 18 338 12 335 C 5 332 2 327 1 320 C 0 313 2 307 5 301 C 15 283 31 273 51 271 C 53 271 56 270 58 269 C 63 268 64 266 61 262 C 58 259 55 256 53 252 C 44 235 57 218 73 213 C 79 211 86 210 93 209 C 95 209 98 208 102 207 C 99 205 98 203 96 201 C 90 194 83 188 78 182 C 65 166 60 147 58 127 C 56 97 63 69 83 45 C 102 21 126 7 157 3 C 182 0 207 2 230 14 C 264 32 284 60 290 98 C 294 122 295 146 284 169 C 273 194 254 213 229 225 M 245 167 C 246 166 247 165 248 163 C 255 155 259 146 259 134 C 259 125 259 115 260 106 C 261 92 257 80 245 71 C 240 67 235 61 230 57 C 224 53 218 48 212 44 C 197 37 182 36 166 38 C 134 42 111 60 99 90 C 88 118 93 152 119 172 C 128 179 135 188 138 200 C 140 205 143 206 147 205 C 151 204 154 202 157 201 C 167 198 176 196 186 198 C 200 200 213 197 223 187 C 230 180 237 174 245 167 Z', 'M 195 64 C 207 62 216 67 224 74 C 239 84 246 99 247 116 C 247 131 244 144 234 155 C 232 157 229 159 226 160 C 220 162 215 161 212 156 C 208 152 208 147 210 142 C 211 137 213 131 214 126 C 215 112 210 104 198 98 C 196 97 195 97 194 96 C 187 93 183 88 183 80 C 183 73 187 67 195 64 Z'] },
  learned: { vb: '0 0 353 364', fill: ['M 271 173 C 273 194 270 214 256 231 C 252 236 248 241 243 245 C 233 253 230 263 229 275 C 229 283 227 290 226 298 C 225 305 225 312 226 318 C 229 333 225 343 213 351 C 208 354 202 356 196 357 C 181 360 166 361 150 363 C 146 363 141 362 138 360 C 131 357 129 351 129 344 C 130 336 133 330 141 328 C 146 326 153 325 159 324 C 168 323 177 323 186 323 C 192 323 195 320 195 316 C 195 314 193 312 191 311 C 188 310 184 310 180 310 C 165 311 150 312 134 309 C 126 307 122 303 122 295 C 122 287 123 279 124 271 C 125 259 120 251 111 244 C 87 225 80 200 83 171 C 84 155 90 141 100 128 C 116 107 137 94 163 90 C 210 83 254 111 268 157 C 270 162 270 167 271 173 M 229 153 C 227 150 225 146 222 144 C 197 118 142 119 122 162 C 113 180 115 199 131 214 C 136 218 141 223 144 227 C 149 233 153 240 155 246 C 157 254 158 263 159 272 C 159 275 159 277 163 277 C 171 277 179 277 187 277 C 193 276 194 274 194 268 C 195 250 202 234 215 221 C 221 215 228 209 233 201 C 242 185 238 169 229 153 Z', 'M 159 46 C 159 37 159 29 159 20 C 159 9 167 1 177 1 C 187 1 195 9 195 20 C 195 31 195 43 195 54 C 195 63 187 70 177 70 C 168 70 160 64 159 55 C 159 52 159 49 159 46 Z', 'M 240 71 C 247 62 253 54 259 45 C 262 42 265 38 269 35 C 276 29 285 30 291 36 C 297 42 298 51 293 58 C 286 68 278 77 270 87 C 264 94 256 95 248 90 C 241 87 238 79 240 71 Z', 'M 94 93 C 90 90 86 88 83 85 C 75 77 68 68 62 59 C 56 51 57 41 63 35 C 71 29 82 29 88 37 C 96 46 104 56 111 66 C 115 71 115 78 112 84 C 108 91 102 93 94 93 Z', 'M 327 111 C 339 106 350 113 352 123 C 352 130 349 138 343 141 C 332 146 321 150 309 154 C 299 158 290 154 287 145 C 283 135 288 126 298 122 C 308 118 317 115 327 111 Z', 'M 61 151 C 54 155 48 154 42 152 C 33 148 23 144 14 141 C 4 137 -1 128 3 118 C 6 109 16 105 25 109 C 36 113 47 117 57 121 C 69 126 70 144 61 151 Z'] },
  completed: { vb: '0 0 328 327', fill: ['M 102 15 C 124 7 147 1 171 1 C 179 1 185 5 188 13 C 192 22 188 33 178 37 C 174 38 170 39 166 39 C 145 38 126 46 108 55 C 101 58 94 65 90 72 C 81 87 69 99 56 111 C 45 121 38 134 36 149 C 35 159 39 168 43 176 C 49 187 50 198 49 209 C 49 215 49 220 50 225 C 51 232 55 238 61 242 C 63 243 65 244 68 245 C 84 252 97 262 108 276 C 115 284 123 291 135 290 C 141 289 146 288 152 286 C 165 282 179 281 193 283 C 210 286 223 281 232 266 C 240 254 250 245 262 238 C 268 234 272 230 277 226 C 285 218 283 208 282 198 C 280 187 282 177 285 167 C 288 159 290 151 289 143 C 289 133 282 127 275 121 C 263 111 253 100 252 84 C 251 79 251 74 250 69 C 250 64 248 59 243 56 C 239 54 234 51 230 49 C 217 43 214 27 224 18 C 230 14 237 13 243 16 C 262 23 277 35 283 56 C 285 61 285 67 286 73 C 286 80 290 86 295 92 C 301 98 309 105 314 112 C 326 129 330 148 322 168 C 319 178 317 189 318 200 C 321 226 309 246 289 262 C 284 266 277 270 272 274 C 266 280 261 287 256 293 C 241 313 221 324 195 319 C 182 317 169 318 157 322 C 129 332 105 323 84 304 C 78 298 72 292 65 286 C 61 282 56 280 51 277 C 32 267 18 252 14 230 C 13 224 13 218 13 211 C 14 202 13 194 9 186 C 4 175 0 163 0 151 C 0 128 9 108 24 91 C 29 87 34 82 38 78 C 43 71 49 65 53 58 C 64 38 81 24 102 15 Z', 'M 178 153 C 191 136 204 119 218 103 C 222 97 228 94 236 96 C 243 98 249 103 249 111 C 250 115 248 121 245 125 C 237 137 227 149 218 161 C 201 182 185 202 169 222 C 157 236 141 236 129 223 C 123 216 119 208 114 200 C 108 190 102 179 93 171 C 84 162 83 152 88 143 C 94 134 109 131 118 138 C 124 143 128 150 132 156 C 136 163 139 171 144 178 C 148 185 151 185 157 179 C 164 171 171 162 178 153 Z'] },
  next_steps: { vb: '0 0 357 313', fill: ['M 200 248 C 203 244 206 240 209 235 C 219 217 234 205 253 197 C 262 193 269 187 275 180 C 280 174 286 169 291 164 C 296 159 295 156 290 152 C 283 146 277 139 270 134 C 260 126 249 120 238 113 C 225 105 215 94 210 79 C 206 70 198 63 189 57 C 183 53 177 49 172 44 C 165 38 162 30 164 20 C 166 10 172 5 182 2 C 189 1 195 3 200 7 C 218 22 237 36 247 58 C 252 71 262 79 275 86 C 288 92 299 102 310 113 C 317 121 326 127 335 134 C 338 137 343 139 346 142 C 357 151 358 164 348 173 C 340 180 331 186 323 192 C 315 197 309 203 303 210 C 296 219 287 225 277 230 C 260 238 247 250 237 266 C 226 283 213 297 196 308 C 189 313 182 314 174 311 C 161 306 157 287 167 276 C 172 270 180 266 186 260 C 191 257 195 252 200 248 Z', 'M 182 114 C 192 116 201 121 209 126 C 219 132 229 137 240 142 C 252 148 256 161 250 172 C 245 179 234 182 224 180 C 214 178 207 173 200 166 C 195 163 191 159 186 156 C 179 152 175 153 170 159 C 164 165 158 172 152 177 C 139 188 122 184 112 175 C 108 171 104 167 101 163 C 99 161 98 160 97 158 C 89 150 80 149 71 158 C 66 162 61 167 56 172 C 45 180 33 183 20 182 C 10 181 3 175 1 166 C -1 157 2 149 9 145 C 12 143 15 141 19 141 C 31 141 40 134 50 126 C 55 122 62 117 69 114 C 86 109 103 112 117 124 C 121 128 124 132 128 135 C 133 139 137 139 141 135 C 145 131 148 128 152 124 C 161 117 171 113 182 114 Z'] },
  notes: { vb: '0 0 353 364', stroke: [['M 176 68 C 167 41 123 31 105 58 C 71 53 44 88 54 129 C 31 151 31 202 56 225 C 46 266 76 300 114 294 C 129 321 161 327 177 302', 33], ['M 176 68 C 189 39 234 35 251 60 C 285 60 310 94 298 135 C 321 160 317 209 293 229 C 302 270 274 302 236 294 C 221 319 191 327 177 302', 33], ['M 176 68 C 171 113 183 147 176 188 C 170 231 181 264 177 302', 31], ['M 91 129 C 112 119 133 133 129 166', 30], ['M 99 241 C 110 223 137 223 138 251', 30], ['M 263 117 C 240 115 223 131 229 160', 30], ['M 263 223 C 244 211 217 221 217 249', 30]] },
}
const SUM_SECTIONS = [['investigated', 'Investigated'], ['learned', 'Learned'], ['completed', 'Completed'], ['next_steps', 'Next Steps'], ['notes', 'Notes']] as const

function SumIcon({ k }: { k: string }) {
  const i = SUM_ICONS[k]
  return (
    <svg className="sum-icon" viewBox={i.vb} aria-hidden="true">
      {i.fill && <g fill="currentColor">{i.fill.map((d, n) => <path key={n} d={d} />)}</g>}
      {i.stroke && <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">{i.stroke.map(([d, w], n) => <path key={n} d={d} strokeWidth={w} />)}</g>}
    </svg>
  )
}

/** A session summary: the request as headline, then the non-empty sections; soft delete with Undo. */
export function SummaryCard({ x, onChange }: { x: Summary; onChange: (x: Summary) => void }) {
  const [err, setErr] = useState('')
  if (x.deleted_at) return <Deleted label={x.request || 'Session summary'} onUndo={async () => onChange(await api.sumRestore(x.id))} />
  const remove = async () => {
    try { await api.sumDelete(x.id); onChange({ ...x, deleted_at: new Date().toISOString() }) } catch (e) { setErr(errText(e)) }
  }
  return (
    <article className="card pad sum-card">
      <div className="fc-head">
        <div><span className="badge sum-badge">Session summary</span><span className="tag">{x.project}</span></div>
        <div className="fc-tools"><button className="vmt del" onClick={remove}>delete</button></div>
      </div>
      {x.request && <h2 className="sum-title">{x.request}</h2>}
      {SUM_SECTIONS.some(([k]) => x[k]) && <div className="sum-rule" />}
      {SUM_SECTIONS.filter(([k]) => x[k]).map(([k, label]) => (
        <section key={k} className="sum-sec">
          <div className="sum-label"><SumIcon k={k} />{label}</div>
          <div className="sum-body">{x[k]}</div>
        </section>
      ))}
      <div className="fc-foot mono">session {x.session_id.slice(0, 8)} • prompt #{x.prompt_number} • {fmtTime(x.created_at)}</div>
      {err && <div className="err">{err}</div>}
    </article>
  )
}

const CLAMP_LINES = 8
const CLAMP_CHARS = 600

/** A user prompt: clamped after 8 lines or 600 characters (machine-driven sessions paste thousands). No delete. */
export function PromptCard({ p }: { p: PromptItem }) {
  const [open, setOpen] = useState(false)
  const long = p.text.split('\n').length > CLAMP_LINES || p.text.length > CLAMP_CHARS
  return (
    <div className="card pad prompt-card">
      <div className="fc-head"><div><span className="badge prompt-badge">Prompt #{p.prompt_number}</span></div></div>
      <div className={'prompt-text' + (long && !open ? ' clamped' : '')}>{p.text}</div>
      {long && <button className="linkbtn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
      <div className="fc-foot mono">session {p.session_id.slice(0, 8)} • {fmtTime(p.created_at)}</div>
    </div>
  )
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const KINDS: Kind[] = ['skill', 'agent', 'command', 'workflow']
/** Workflow YAML written by the backend/mock (`steps: - cap: x / agent: y`) → steps; the detail has no `steps` field (reported). */
export const parseSteps = (yaml: string): WorkflowStep[] =>
  [...yaml.matchAll(/-\s+cap:\s*(\S+)(?:\s*\n\s+agent:\s*(\S+))?/g)].map(([, cap, agent]) => (agent ? { cap, agent } : { cap }))

/** Create (any editable scope) or edit (description, body or steps) a capability. Ready for F5's workflow steps. */
export function CapabilityForm({ edit, projects, project, onDone, onCancel }: {
  edit?: CapabilityDetail; projects: string[]; project: string | null; onDone: () => void; onCancel: () => void
}) {
  const [f, setF] = useState<NewCapability>(() => edit
    ? { kind: edit.kind, scope: edit.namespace === 'user' ? 'user' : 'project', name: edit.name, description: edit.description, body: edit.body, steps: edit.kind === 'workflow' ? parseSteps(edit.body) : undefined }
    : { kind: 'skill', scope: project ? 'project' : 'user', project: project ?? projects[0], name: '', description: '', body: '', steps: [{ cap: '' }] })
  const [err, setErr] = useState('')
  const nameErr = !edit && f.name && !NAME_RE.test(f.name) ? 'Lowercase letters, digits and dashes; must start with a letter or digit; up to 64 characters.' : ''
  const steps = f.steps ?? []
  const setStep = (i: number, s: WorkflowStep) => setF({ ...f, steps: steps.map((x, j) => (j === i ? s : x)) })
  const cleanSteps = steps.filter(s => s.cap.trim()).map(s => (s.agent?.trim() ? { cap: s.cap.trim(), agent: s.agent.trim() } : { cap: s.cap.trim() }))

  const submit = async () => {
    if (nameErr || !f.description.trim() || (!edit && !f.name)) return setErr('Name and description are required.')
    try {
      if (edit) await api.updateCapability(edit.id, f.kind === 'workflow' ? { description: f.description, steps: cleanSteps } : { description: f.description, body: f.body })
      else await api.createCapability(f.kind === 'workflow' ? { ...f, body: undefined, steps: cleanSteps } : { ...f, steps: undefined, project: f.scope === 'project' ? f.project : undefined })
      onDone()
    } catch (e) { setErr(errText(e)) }
  }

  return (
    <div className="form">
      {!edit && (
        <>
          <Segmented options={KINDS} value={f.kind} onChange={kind => setF({ ...f, kind })} />
          <div className="row2">
            <label>Scope<select value={f.scope} onChange={e => setF({ ...f, scope: e.target.value as 'user' | 'project' })}>
              <option value="user">user (~/.claude)</option><option value="project">project (.claude in the repo)</option></select></label>
            <label>Project<select value={f.project} disabled={f.scope === 'user'} onChange={e => setF({ ...f, project: e.target.value })}>
              {projects.map(p => <option key={p}>{p}</option>)}</select></label>
          </div>
          <label>Name<input value={f.name} placeholder="release-notes" onChange={e => setF({ ...f, name: e.target.value })} />{nameErr && <span className="err">{nameErr}</span>}</label>
        </>
      )}
      <label>Description (what Claude matches against)<input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      {f.kind === 'workflow' ? (
        <label>Steps (capability, optional agent)
          {steps.map((s, i) => (
            <div key={i} className="steprow">
              <input value={s.cap} placeholder="superpowers:writing-plans" onChange={e => setStep(i, { ...s, cap: e.target.value })} />
              <input value={s.agent ?? ''} placeholder="agent (optional)" onChange={e => setStep(i, { ...s, agent: e.target.value })} />
              <button className="iconbtn" aria-label="Remove step" onClick={() => setF({ ...f, steps: steps.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
          <button className="btn" style={{ justifySelf: 'start' }} onClick={() => setF({ ...f, steps: [...steps, { cap: '' }] })}>+ step</button>
        </label>
      ) : (
        <label>Body (Markdown; frontmatter is written for you)<textarea value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></label>
      )}
      <div className="actions">
        <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={submit}>{edit ? 'Save' : 'Create'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
        {err && <span className="err">{err}</span>}
      </div>
    </div>
  )
}

/** Polls GET /jobs/{id} every second until done or failed; stops on unmount or when `id` changes. */
export function useJob(id: string | null): Job | null {
  const [job, setJob] = useState<Job | null>(null)
  useEffect(() => {
    if (!id) return
    let timer = 0
    let alive = true
    const tick = async () => {
      try {
        const j = await api.job(id)
        if (!alive) return
        setJob(j)
        if (j.status !== 'done' && j.status !== 'failed') timer = window.setTimeout(tick, 1000)
      } catch (e) {
        if (alive) setJob({ id, kind: 'index', status: 'failed', progress: 0, result: null, error: errText(e), created_at: new Date().toISOString() })
      }
    }
    setJob(null)
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [id])
  return job
}
