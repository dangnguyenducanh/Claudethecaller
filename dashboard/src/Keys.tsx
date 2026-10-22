import { useEffect, useState } from 'react'
import { ApiError, api, errText } from './api'
import type { ApiKey } from './types'
import { Header, fmtTime } from './ui'

/** Shared mode only. A 404 from /api/keys means the daemon runs in local mode: say so quietly, no error. */
export default function Keys() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [localMode, setLocalMode] = useState(false)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<ApiKey | null>(null) // the new key, shown once
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')

  const load = () => api.keys().then(setKeys).catch(e => (e instanceof ApiError && e.status === 404 ? setLocalMode(true) : setErr(errText(e))))
  useEffect(() => { load() }, [])

  const create = async () => {
    if (!name.trim()) return setErr('Give the key a name, e.g. laptop.')
    try { setErr(''); setFresh(await api.createKey(name.trim())); setCopied(false); setName(''); load() } catch (e) { setErr(errText(e)) }
  }
  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke "${k.name}"? Anything using it gets 401 immediately.`)) return
    try { await api.revokeKey(k.id); load() } catch (e) { setErr(errText(e)) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(fresh!.key!); setCopied(true) } catch { setErr('Copy failed; select the key and copy it by hand.') }
  }

  if (localMode) return (
    <>
      <Header crumb="Keys" title="API keys" sub="Shared mode only" />
      <div className="card pad muted">This daemon runs in local mode: there is no auth and no keys. Set shared mode to issue keys.</div>
    </>
  )
  return (
    <>
      <Header crumb="Keys" title="API keys" sub={`${keys.filter(k => !k.revoked_at).length} active · sent as “Authorization: Bearer <key>”`}>
        <input className="inline-input" value={name} placeholder="key name, e.g. laptop" aria-label="New key name" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} />
        <button className="btn" onClick={create}>New key</button>
      </Header>
      {err && <div className="err">{err}</div>}
      {fresh?.key && (
        <div className="card pad form keybox">
          <div className="card-title">Key “{fresh.name}” created</div>
          <div className="err">Copy it now. It can’t be shown again; only its hash is stored.</div>
          <code className="code">{fresh.key}</code>
          <div className="actions">
            <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
            <button className="btn" onClick={() => setFresh(null)}>I saved it</button>
          </div>
        </div>
      )}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Created</th><th>Status</th><th /></tr></thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id}>
                <td className="title">{k.name}<div className="subline mono">#{k.id}</div></td>
                <td className="muted">{fmtTime(k.created_at)}</td>
                <td>{k.revoked_at ? <span className="tag bad">revoked {fmtTime(k.revoked_at)}</span> : <span className="tag good">active</span>}</td>
                <td>{!k.revoked_at && <button className="btn danger" onClick={() => revoke(k)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!keys.length && <div className="empty">No keys yet.</div>}
      </div>
    </>
  )
}
