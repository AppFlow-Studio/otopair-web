'use client'

import { ReactNode, useState } from 'react'
import { Button, Modal, Input } from './Primitives'

/**
 * AdminActionPanel — shared "Admin controls" card used by Cars / Configs /
 * Users / Shops modals. Renders a titled section with a vertical stack of
 * action rows, each optionally with a description.
 */

export const AdminActionPanel = ({ title = 'Admin controls', subtitle, children }: {
  title?: string; subtitle?: string; children: ReactNode
}) => (
  <div style={{ background:'var(--slate-25)', border:'1px solid var(--slate-200)', borderRadius:10, padding:'14px 16px', display:'flex', flexDirection:'column', gap:8 }}>
    <div>
      <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{title}</div>
      {subtitle && <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:2 }}>{subtitle}</div>}
    </div>
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      {children}
    </div>
  </div>
)

export const ActionRow = ({
  label, hint, action, danger,
}: { label: string; hint?: ReactNode; action: ReactNode; danger?: boolean }) => (
  <div style={{
    display:'flex', alignItems:'center', justifyContent:'space-between', gap:10,
    background:'#fff', border:`1px solid ${danger ? '#FECACA' : 'var(--slate-200)'}`,
    borderRadius:8, padding:'8px 12px',
  }}>
    <div style={{ minWidth:0 }}>
      <div style={{ fontSize:13, fontWeight:500, color: danger ? 'var(--red-700)' : 'var(--slate-900)' }}>{label}</div>
      {hint && <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:2 }}>{hint}</div>}
    </div>
    <div>{action}</div>
  </div>
)

export const Toast = ({ msg, onDismiss }: { msg: string | null; onDismiss?: () => void }) => {
  if (!msg) return null
  return (
    <div style={{
      position:'fixed', bottom:24, right:24, zIndex:400,
      background:'var(--slate-900)', color:'#fff',
      padding:'10px 14px', borderRadius:8, fontSize:13, fontWeight:500,
      boxShadow:'0 10px 30px rgba(15,23,42,0.25)',
      display:'flex', alignItems:'center', gap:8,
    }} onClick={onDismiss}>
      <span>✓</span> {msg}
    </div>
  )
}

// Small reason-prompt modal — used by destructive actions.
export const ReasonPromptModal = ({
  open, action, prefill, danger, onConfirm, onClose,
}: {
  open: boolean
  action: string
  prefill?: string
  danger?: boolean
  onConfirm: (reason: string) => void
  onClose: () => void
}) => {
  const [reason, setReason] = useState(prefill ?? '')
  return (
    <Modal open={open} onClose={onClose} width={460}
      title={`Confirm: ${action}`}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={!reason.trim()}
          onClick={() => { if (reason.trim()) { onConfirm(reason); setReason('') } }}>
          Confirm {action}
        </Button>
      </>}>
      <div style={{ padding:22 }}>
        <div style={{ fontSize:13, color:'var(--slate-600)', marginBottom:14 }}>
          A reason is required and will be written to the audit trail.
        </div>
        <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Reason</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Why are you taking this action?"
          style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
      </div>
    </Modal>
  )
}

// Amount + description prompt — used by manual-credit action.
export const CreditPromptModal = ({
  open, onConfirm, onClose,
}: {
  open: boolean
  onConfirm: (amount: number, description: string) => void
  onClose: () => void
}) => {
  const [amount, setAmount] = useState('')
  const [desc,   setDesc]   = useState('')
  const num = Number(amount)
  const valid = amount.trim() !== '' && !Number.isNaN(num) && desc.trim() !== ''
  return (
    <Modal open={open} onClose={onClose} width={480}
      title="Issue manual credit"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid}
          onClick={() => { if (valid) { onConfirm(num, desc.trim()); setAmount(''); setDesc('') } }}>
          Issue credit
        </Button>
      </>}>
      <div style={{ padding:22, display:'flex', flexDirection:'column', gap:12 }}>
        <div style={{ fontSize:13, color:'var(--slate-600)' }}>
          Positive amount = credit (account gains balance). Negative = debit. Logged to audit + transactions.
        </div>
        <div>
          <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Amount (USD)</label>
          <Input value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 25.00" type="number" />
        </div>
        <div>
          <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Description</label>
          <Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Goodwill for delayed booking #b587304f" />
        </div>
      </div>
    </Modal>
  )
}
