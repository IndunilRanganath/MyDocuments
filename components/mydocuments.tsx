'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronRight, FileText, Fingerprint, Globe2, IdCard, KeyRound, LoaderCircle, LockKeyhole, LogOut, MoreHorizontal, Plus, ScanLine, ShieldCheck, Trash2, Upload, X, Camera, Pencil, CalendarDays, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { base64, daysUntil, decrypt, decryptMeta, encrypt, encryptMeta, importMyDocumentsKey, newMyDocumentsKey, recoverySecret, unwrapKey, validateFile, wrapKey, type DocType, type Envelope, type Metadata } from '@/lib/crypto';
import { PinPad } from './pin-pad';
type Row = { id: string; encrypted_meta: string; created_at: string };
type Document = Row & { meta: Metadata };
type AuthResult = { pin_envelope: Envelope; recovery_envelope: Envelope | null; username: string };
const types: DocType[] = ['Passport', 'ID', 'Visa', 'Other'];
const icons = { Passport: Globe2, ID: IdCard, Visa: ScanLine, Other: FileText };
function DocIcon({ type, size = 26 }: { type: DocType; size?: number }) { const Icon = icons[type] || FileText; return <Icon size={size} strokeWidth={1.4}/>; }
function Spinner() { return <LoaderCircle size={20} className="spin" aria-label="Loading"/>; }
function expiryLabel(expiry: string) { const days = daysUntil(expiry); return days === null || days > 90 ? null : days < 0 ? 'Expired' : days === 0 ? 'Expires today' : `${days} days left`; }
export default function MyDocuments() {
  const [mode, setMode] = useState<'login' | 'signup' | 'recover'>('login');
  const [username, setUsername] = useState(''); const [pin, setPin] = useState(''); const [firstPin, setFirstPin] = useState('');
  const [recovery, setRecovery] = useState(''); const [unlocked, setUnlocked] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); const [configured, setConfigured] = useState<boolean | null>(null);
  const [docs, setDocs] = useState<Document[]>([]); const [filter, setFilter] = useState('All'); const [onlyExpiring, setOnlyExpiring] = useState(false);
  const [screen, setScreen] = useState<'home' | 'add' | 'view' | 'settings' | 'reset'>('home'); const [menu, setMenu] = useState(false);
  const [selected, setSelected] = useState<Document | null>(null); const [preview, setPreview] = useState(''); const [previewLoading, setPreviewLoading] = useState(false);
  const [rename, setRename] = useState(false); const [newName, setNewName] = useState(''); const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedRecovery, setSavedRecovery] = useState(''); const [hasRecovery, setHasRecovery] = useState(false);
  const key = useRef<CryptoKey | null>(null); const rawKey = useRef<Uint8Array<ArrayBuffer> | null>(null); const epoch = useRef(0); const previewUrl = useRef('');
  const lastActivity = useRef(Date.now()); const lastHeartbeat = useRef(Date.now()); const heartbeatPending = useRef(false);
  const clearPreview = useCallback(() => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = ''; setPreview(''); }, []);
  const lock = useCallback((message = 'MyDocuments locked') => {
    epoch.current++; rawKey.current?.fill(0); rawKey.current = null; key.current = null; clearPreview();
    setUnlocked(false); setDocs([]); setSelected(null); setPin(''); setFirstPin(''); setRecovery(''); setSavedRecovery(''); setScreen('home'); setMenu(false); setError(''); setBusy(false); setNotice(message); setRename(false); setConfirmDelete(false); setMode('login');
    void api('auth/logout', {}).catch(() => {});
  }, [clearPreview]);
  useEffect(() => {
    void api<{ configured: boolean }>('health').then(d => setConfigured(d.configured)).catch(() => setConfigured(false));
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
    const locked = () => lock('Session ended. Unlock to continue.'); window.addEventListener('mydocuments:locked', locked);
    return () => { window.removeEventListener('mydocuments:locked', locked); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, [lock]);
  useEffect(() => {
    if (!unlocked) return;
    lastActivity.current = Date.now(); lastHeartbeat.current = Date.now();
    const activity = () => {
      const now = Date.now(); if (now - lastActivity.current >= 120000) { lock(); return; }
      lastActivity.current = now;
      if (now - lastHeartbeat.current > 25000 && !heartbeatPending.current) {
        heartbeatPending.current = true; lastHeartbeat.current = now;
        void api('session', {}).catch(() => lock()).finally(() => { heartbeatPending.current = false; });
      }
    };
    const check = () => { if (Date.now() - lastActivity.current >= 120000) lock(); };
    const timer = setInterval(check, 1000);
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach(e => window.addEventListener(e, activity, { passive: true }));
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); events.forEach(e => window.removeEventListener(e, activity)); document.removeEventListener('visibilitychange', check); };
  }, [unlocked, lock]);
  useEffect(() => {
    if (!rename && !confirmDelete) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('.modal');
    if (!rename) dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { setRename(false); setConfirmDelete(false); }
      if (event.key !== 'Tab' || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]'));
      const first = items[0]; const last = items[items.length - 1];
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
  }, [rename, confirmDelete, busy]);
  async function loadDocuments(documentsKey: CryptoKey, version: number) {
    const result = await api<{ documents: Row[] }>('documents');
    const decrypted = await Promise.all(result.documents.map(async row => ({ ...row, meta: await decryptMeta(documentsKey, row.encrypted_meta, row.id) })));
    if (epoch.current === version) setDocs(decrypted);
  }
  async function authenticate(e: FormEvent) {
    e.preventDefault(); setError(''); setNotice('');
    if (!username.trim()) { setError('Enter your username.'); return; }
    if (mode !== 'recover' && pin.length !== 6) { setError('Enter a six-digit PIN.'); return; }
    if (mode === 'signup' && !firstPin) { setFirstPin(pin); setPin(''); return; }
    if (mode === 'signup' && pin !== firstPin) { setError('PINs do not match. Try again.'); setPin(''); return; }
    setBusy(true); const version = ++epoch.current;
    try {
      let result: AuthResult; let raw: Uint8Array<ArrayBuffer>;
      if (mode === 'signup') { raw = await newMyDocumentsKey(); const envelope = await wrapKey(raw, pin); result = await api<AuthResult>('auth/signup', { username, pin, confirmPin: firstPin, envelope }); }
      else { result = await api<AuthResult>(mode === 'recover' ? 'auth/recover' : 'auth/login', { username, secret: mode === 'recover' ? recovery.trim().toLowerCase() : pin }); const envelope = mode === 'recover' ? result.recovery_envelope : result.pin_envelope; if (!envelope) throw new Error('No recovery key is set up.'); raw = await unwrapKey(envelope, mode === 'recover' ? recovery.trim().toLowerCase() : pin); }
      if (epoch.current !== version) { raw.fill(0); return; }
      rawKey.current = raw; key.current = await importMyDocumentsKey(raw); setUsername(result.username); setHasRecovery(Boolean(result.recovery_envelope));
      setPin(''); setFirstPin(''); setRecovery(''); setUnlocked(true); setScreen(mode === 'recover' ? 'reset' : 'home');
      await loadDocuments(key.current, version);
    } catch (err) { if (epoch.current === version) { setError(err instanceof Error ? err.message : 'Could not unlock.'); if (!key.current) void api('auth/logout', {}).catch(() => {}); } }
    finally { if (epoch.current === version) setBusy(false); }
  }
  function switchMode(next: typeof mode) { setMode(next); setPin(''); setFirstPin(''); setRecovery(''); setError(''); setNotice(''); }
  async function openDocument(doc: Document) {
    clearPreview(); setSelected(doc); setScreen('view'); setPreviewLoading(true); setError(''); const version = epoch.current; const documentsKey = key.current!;
    try {
      const { url } = await api<{ url: string }>(`documents/${doc.id}`); const response = await fetch(url, { cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Could not download document.');
      const plain = await decrypt(documentsKey, new Uint8Array(await response.arrayBuffer()), `mydocuments:file:${doc.id}`);
      if (epoch.current !== version) return;
      const blobUrl = URL.createObjectURL(new Blob([plain], { type: doc.meta.mime })); previewUrl.current = blobUrl; setPreview(blobUrl);
    } catch (err) { if (epoch.current === version) setError(err instanceof Error ? err.message : 'Could not open document.'); }
    finally { if (epoch.current === version) setPreviewLoading(false); }
  }
  async function renameDocument(e: FormEvent) {
    e.preventDefault(); if (!selected || !key.current) return; setBusy(true); setError(''); const version = epoch.current;
    try { const next = { ...selected.meta, name: newName.trim() }; const encrypted_meta = await encryptMeta(key.current, next, selected.id); await api(`documents/${selected.id}`, { encrypted_meta }, 'PATCH'); if (version !== epoch.current) return; setDocs(v => v.map(d => d.id === selected.id ? { ...d, meta: next, encrypted_meta } : d)); setSelected({ ...selected, meta: next }); setRename(false); }
    catch (err) { if (version === epoch.current) setError((err as Error).message); } finally { if (version === epoch.current) setBusy(false); }
  }
  async function deleteDocument() {
    if (!selected) return; setBusy(true); setError(''); const version = epoch.current;
    try { await api(`documents/${selected.id}`, undefined, 'DELETE'); if (version !== epoch.current) return; setDocs(v => v.filter(d => d.id !== selected.id)); clearPreview(); setSelected(null); setScreen('home'); setConfirmDelete(false); }
    catch (err) { if (version === epoch.current) setError((err as Error).message); } finally { if (version === epoch.current) setBusy(false); }
  }
  async function createRecovery() {
    if (!rawKey.current) return; setBusy(true); setError(''); const version = epoch.current;
    try { const secret = recoverySecret(); const envelope = await wrapKey(rawKey.current, secret); await api('settings/recovery', { secret, envelope }); if (version === epoch.current) { setSavedRecovery(secret); setHasRecovery(true); } }
    catch (err) { if (version === epoch.current) setError((err as Error).message); } finally { if (version === epoch.current) setBusy(false); }
  }
  async function resetPin(e: FormEvent) {
    e.preventDefault(); if (!rawKey.current) return; setBusy(true); setError(''); const version = epoch.current;
    try { if (pin !== firstPin) throw new Error('PINs do not match.'); const envelope = await wrapKey(rawKey.current, pin); await api('settings/pin', { pin, confirmPin: firstPin, envelope }); if (version === epoch.current) lock('PIN updated. Sign in with your new PIN.'); }
    catch (err) { if (version === epoch.current) { setError((err as Error).message); setBusy(false); } }
  }
  if (!unlocked) return <main className="app-shell auth-shell">
    <header className="brand"><span className="brand-icon"><LockKeyhole size={21} strokeWidth={1.7}/></span><span>MyDocuments</span></header>
    <div className="auth-heading"><div className="eyebrow">YOUR PERSONAL SPACE</div><h1>{mode === 'signup' ? firstPin ? 'Once more.' : 'Make it yours.' : mode === 'recover' ? 'Your way back.' : 'Welcome back.'}</h1><p>{mode === 'signup' ? firstPin ? 'Confirm your 6-digit PIN' : 'Choose a username and 6-digit PIN' : mode === 'recover' ? 'Enter your saved recovery key' : 'Enter your 6-digit PIN'}</p></div>
    <form onSubmit={authenticate} className="auth-form">
      <label className="field-label" htmlFor="username">Username or email</label><input id="username" className="text-input" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={120} value={username} onChange={e => setUsername(e.target.value)} disabled={busy || Boolean(firstPin)} placeholder="Your username" required minLength={3}/>
      {mode === 'recover' ? <label className="stack-field">Recovery key<textarea className="text-input recovery-input" value={recovery} onChange={e => setRecovery(e.target.value)} autoComplete="off" spellCheck={false} required placeholder="64-character key"/></label> : <PinPad value={pin} onChange={setPin} disabled={busy}/>}
      {error && <p role="alert" className="error"><AlertCircle size={15}/>{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
      {configured === false && <p className="setup-note">Setup needed · Add Supabase environment variables. See README.</p>}
      <button className="button primary" disabled={busy || (mode !== 'recover' && pin.length !== 6) || (mode === 'recover' && recovery.trim().length !== 64)}>{busy ? <Spinner/> : <>{mode === 'signup' ? firstPin ? 'Create account' : 'Continue' : mode === 'recover' ? 'Recover documents' : 'Unlock documents'}<ArrowRight size={18}/></>}</button>
    </form>
    <div className="auth-footer">{mode === 'login' ? <><span>New here? <button className="text-button" onClick={() => switchMode('signup')}>Create an account</button></span><button className="muted-link" onClick={() => switchMode('recover')}>Forgot PIN?</button></> : <><button className="text-button" onClick={() => switchMode('login')}>Back to sign in</button>{mode === 'signup' && <p className="security-note">Forgotten PIN = lost documents.<br/>Add a recovery key in Settings.</p>}</>}
      <span className="privacy-caption"><ShieldCheck size={14}/> Private by design</span>
    </div>
  </main>;
  const expiring = docs.filter(d => expiryLabel(d.meta.expiry)); const visibleDocs = docs.filter(d => (filter === 'All' || d.meta.type === filter) && (!onlyExpiring || expiryLabel(d.meta.expiry)));
  return <main className={`app-shell ${screen === 'view' ? 'viewer-shell' : ''}`}>
    {screen === 'home' ? <>
      <header className="home-header"><div className="brand"><span className="brand-icon"><LockKeyhole size={21} strokeWidth={1.7}/></span><span>MyDocuments</span></div><div className="menu-wrap"><button className="icon-button" aria-label="Open menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={24}/></button>{menu && <><button className="menu-backdrop" aria-label="Close menu" onClick={() => setMenu(false)}/><div className="menu" role="menu"><span className="menu-user">{username}</span><button role="menuitem" onClick={() => { setScreen('settings'); setMenu(false); setError(''); }}><KeyRound size={18}/>Settings<ChevronRight size={16}/></button><button role="menuitem" onClick={() => lock('Signed out')}><LogOut size={18}/>Log out</button></div></>}</div></header>
      <section className="home-title"><div className="eyebrow"><span className="status-dot"/> ENCRYPTED & PRIVATE</div><h1>Your documents<span className="count">{docs.length.toString().padStart(2,'0')}</span></h1><p>Personal documents</p></section>
      {expiring.length > 0 && <button className={`expiry-summary ${onlyExpiring ? 'selected' : ''}`} onClick={() => setOnlyExpiring(!onlyExpiring)}><CalendarDays size={17}/><span>{expiring.length} document{expiring.length !== 1 ? 's' : ''} to check</span><ChevronRight size={17}/></button>}
      <nav className="filters" aria-label="Filter by document type">{['All', ...types].map(t => <button key={t} aria-pressed={filter === t} className={filter === t ? 'active' : ''} onClick={() => setFilter(t)}>{t}</button>)}</nav>
      {error && <p className="error" role="alert">{error}</p>}
      {visibleDocs.length ? <div className="document-grid">{visibleDocs.map(doc => { const badge = expiryLabel(doc.meta.expiry); return <button className="document-card" key={doc.id} onClick={() => void openDocument(doc)}><div className="card-top"><span className="doc-icon"><DocIcon type={doc.meta.type}/></span><ArrowRight size={17} className="card-arrow"/></div><div className="card-details"><h2>{doc.meta.name}</h2><span className="doc-type">{doc.meta.type}</span></div>{badge ? <span className={`expiry-badge ${badge === 'Expired' ? 'expired' : ''}`}><span/>{badge}</span> : <span className="card-safe"><LockKeyhole size={11}/> Encrypted</span>}</button>; })}</div> : <div className="empty-state"><span className="empty-icon"><FileText size={36} strokeWidth={1}/><span><LockKeyhole size={15}/></span></span><h2>{docs.length ? 'Nothing here' : 'No documents yet'}</h2><p>{docs.length ? 'Try another filter' : 'Add your first document'}</p><span className="empty-line"/></div>}
      <div className="home-bottom"><span><LockKeyhole size={13}/> Only you hold the key</span><button className="fab" aria-label="Add document" onClick={() => { setScreen('add'); setError(''); }}><Plus size={28} strokeWidth={1.5}/></button></div>
    </> : screen === 'add' ? <AddDocument documentsKey={key.current!} version={epoch.current} isCurrent={v => epoch.current === v} onBack={() => setScreen('home')} onAdded={async () => { await loadDocuments(key.current!, epoch.current); setScreen('home'); }}/>
    : screen === 'view' && selected ? <>
      <header className="page-header"><button className="icon-button" aria-label="Back to documents" onClick={() => { clearPreview(); setSelected(null); setScreen('home'); setError(''); }}><ArrowLeft size={22}/></button><div><h1>{selected.meta.name}</h1><span>{selected.meta.type}</span></div><span className="icon-button decorative"><LockKeyhole size={18}/></span></header>
      <div className="preview-area">{previewLoading ? <Spinner/> : preview ? selected.meta.mime === 'application/pdf' ? <iframe src={preview} title={selected.meta.name} className="pdf-preview"/> : <img src={preview} alt={selected.meta.name} className="image-preview"/> : <div className="preview-error"><FileText size={40}/><p>Preview unavailable</p><button className="text-button" onClick={() => void openDocument(selected)}>Try again</button></div>}</div>
      {selected.meta.expiry && <p className="preview-expiry"><CalendarDays size={14}/>Expires {new Date(selected.meta.expiry + 'T00:00:00').toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' })}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="viewer-actions"><a className={`action-tile ${!preview ? 'disabled' : ''}`} href={preview || undefined} download={selected.meta.filename} aria-disabled={!preview} onClick={e => { if (!preview) e.preventDefault(); }}><ArrowDownToLine size={21}/><span>Download</span></a><button className="action-tile" onClick={() => { setNewName(selected.meta.name); setRename(true); }}><Pencil size={20}/><span>Rename</span></button><button className="action-tile danger" onClick={() => setConfirmDelete(true)}><Trash2 size={20}/><span>Delete</span></button></div>
    </> : screen === 'settings' ? <>
      <PageHeader title="Settings" onBack={() => { setScreen('home'); setSavedRecovery(''); setError(''); }}/>
      <div className="settings-profile"><span className="doc-icon"><Fingerprint size={27} strokeWidth={1.4}/></span><h2>{username}</h2><span className="subtle">Your private documents</span></div>
      <div className="settings-group"><div className="setting-row"><ShieldCheck size={21}/><div><strong>Auto-lock</strong><span>After 2 minutes</span></div><Check size={18}/></div><button className="setting-row" onClick={() => { setScreen('reset'); setPin(''); setFirstPin(''); setError(''); }}><LockKeyhole size={21}/><div><strong>Change PIN</strong><span>All devices will be locked</span></div><ChevronRight size={18}/></button></div>
      <section className="recovery-section"><div className="section-label"><KeyRound size={19}/><h2>Recovery key</h2>{hasRecovery && <span className="tiny-badge">Enabled</span>}</div><p>Keep access if you forget your PIN.</p>{savedRecovery ? <><code className="recovery-code">{savedRecovery}</code><p className="security-note">Save this key somewhere safe. It opens your documents.</p><button className="button primary" onClick={() => downloadText(savedRecovery, 'mydocuments-recovery-key.txt')}><ArrowDownToLine size={18}/>Save recovery key</button><button className="button secondary" onClick={() => setSavedRecovery('')}>I saved my key</button></> : <><button className="button secondary" disabled={busy} onClick={() => void createRecovery()}>{busy ? <Spinner/> : <>{hasRecovery ? 'Replace recovery key' : 'Create recovery key'}<Plus size={18}/></>}</button>{hasRecovery && <span className="security-note">Replacing invalidates your previous key.</span>}</>}
      </section><div className="security-callout"><LockKeyhole size={17}/><p>A 6-digit PIN can be guessed offline. Without a recovery key, a forgotten PIN means lost documents.</p></div>{error && <p role="alert" className="error">{error}</p>}<button className="button logout-button" onClick={() => lock('Signed out')}><LogOut size={18}/>Log out</button>
    </> : screen === 'reset' ? <>
      <PageHeader title="New PIN" onBack={() => { setScreen('settings'); setPin(''); setFirstPin(''); setError(''); }}/><div className="reset-heading"><span className="doc-icon"><LockKeyhole size={26}/></span><h2>Choose a new PIN.</h2><p>Choose and confirm a 6-digit PIN.</p></div>
      <form onSubmit={resetPin} className="reset-form"><label className="stack-field">New PIN<input className="text-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} minLength={6} required pattern="[0-9]{6}" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g,''))}/></label><label className="stack-field">Confirm PIN<input className="text-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} minLength={6} required pattern="[0-9]{6}" value={firstPin} onChange={e => setFirstPin(e.target.value.replace(/\D/g,''))}/></label>{error && <p className="error" role="alert">{error}</p>}<button className="button primary" disabled={busy || pin.length !== 6 || firstPin.length !== 6}>{busy ? <Spinner/> : 'Save PIN & lock'}</button></form>
    </> : null}
    {(rename || confirmDelete) && <div className="modal-backdrop" onClick={() => { if (!busy) { setRename(false); setConfirmDelete(false); } }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={e => e.stopPropagation()}><div className="modal-handle"/><h2 id="dialog-title">{rename ? 'Rename document' : 'Delete document?'}</h2>{rename ? <form onSubmit={renameDocument}><label className="field-label" htmlFor="rename">Document name</label><input id="rename" autoFocus className="text-input" maxLength={80} value={newName} onChange={e => setNewName(e.target.value)} required/><button className="button primary" disabled={busy || !newName.trim()}>{busy ? <Spinner/> : 'Save name'}</button></form> : <><p>This cannot be undone.</p><button className="button destructive" disabled={busy} onClick={() => void deleteDocument()}>{busy ? <Spinner/> : 'Delete document'}</button></>}{error && <p className="error" role="alert">{error}</p>}<button className="button secondary" disabled={busy} onClick={() => { setRename(false); setConfirmDelete(false); }}>Cancel</button></section></div>}
  </main>;
}
function PageHeader({ title, onBack }: { title: string; onBack: () => void }) { return <header className="page-header"><button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeft size={22}/></button><h1>{title}</h1><span className="header-spacer"/></header>; }
function downloadText(text: string, filename: string) { const url = URL.createObjectURL(new Blob([text + '\n'], { type:'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
function AddDocument({ documentsKey, version, isCurrent, onBack, onAdded }: { documentsKey: CryptoKey; version: number; isCurrent: (v: number) => boolean; onBack: () => void; onAdded: () => Promise<void> }) {
  const [type, setType] = useState<DocType>('Passport'); const [name, setName] = useState(''); const [expiry, setExpiry] = useState(''); const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const upload = useRef<HTMLInputElement>(null); const camera = useRef<HTMLInputElement>(null);
  async function choose(file: File | undefined) { if (!file) return; try { await validateFile(file); setFile(file); setError(''); } catch (err) { setError((err as Error).message); } }
  async function save(e: FormEvent) {
    e.preventDefault(); if (!file) return; setBusy(true); setError(''); let id = ''; let intent = false; let complete = false;
    try {
      const mime = await validateFile(file); id = crypto.randomUUID(); setStatus('Encrypting…');
      const meta: Metadata = { name: name.trim(), type, expiry, filename: file.name, mime };
      const [bytes, encrypted_meta] = await Promise.all([encrypt(documentsKey, await file.arrayBuffer(), `mydocuments:file:${id}`), encryptMeta(documentsKey, meta, id)]);
      if (!isCurrent(version)) return;
      const { signedUrl } = await api<{ signedUrl: string }>('documents/upload', { id, encrypted_meta, ciphertext_size: bytes.length }); intent = true; setStatus('Saving…');
      if (!isCurrent(version)) return;
      const result = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: new Blob([bytes]) });
      if (!result.ok) throw new Error('Upload failed. Please try again.');
      if (!isCurrent(version)) return;
      await api(`documents/${id}/complete`, {}); complete = true;
      if (isCurrent(version)) await onAdded();
    } catch (err) { if (isCurrent(version)) { setError((err as Error).message); if (intent && !complete) await api(`documents/${id}`, undefined, 'DELETE').catch(() => {}); } }
    finally { if (isCurrent(version)) { setBusy(false); setStatus(''); } }
  }
  return <><PageHeader title="Add document" onBack={onBack}/><form className="add-form" onSubmit={save}>
    <label className="field-label">Document type</label><div className="type-picker">{types.map(t => <button type="button" key={t} aria-pressed={type === t} disabled={busy} className={type === t ? 'active' : ''} onClick={() => setType(t)}><DocIcon type={t} size={24}/><span>{t}</span></button>)}</div>
    <label className="stack-field">Name<input className="text-input" placeholder="e.g. My passport" value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy}/></label>
    <label className="stack-field">Expiry date <span className="optional">Optional</span><input className="text-input" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} min="1900-01-01" max="2200-12-31" disabled={busy}/></label>
    <label className="field-label">Document file</label><input ref={upload} type="file" accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf" className="sr-only" aria-label="Choose document file" onChange={e => { void choose(e.target.files?.[0]); e.target.value=''; }}/><input ref={camera} type="file" accept="image/jpeg,image/png" capture="environment" className="sr-only" aria-label="Take a document photo" onChange={e => { void choose(e.target.files?.[0]); e.target.value=''; }}/>
    <button className={`upload-zone ${file ? 'has-file' : ''}`} type="button" onClick={() => upload.current?.click()} disabled={busy}><span className="upload-icon">{file ? <Check size={24}/> : <Upload size={24} strokeWidth={1.5}/>}</span><strong>{file ? file.name : 'Choose a file'}</strong><span>{file ? `${(file.size/1024/1024).toFixed(1)} MB · Tap to replace` : 'JPG, PNG or PDF · Up to 10 MB'}</span></button>
    <button className="button camera-button" type="button" onClick={() => camera.current?.click()} disabled={busy}><Camera size={19} strokeWidth={1.5}/>Take a photo</button>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="add-footer"><span className="privacy-caption"><LockKeyhole size={13}/>Encrypted before it leaves your device</span><button className="button primary" disabled={busy || !file || !name.trim()}>{busy ? <><Spinner/>{status}</> : <>Save document<ArrowRight size={18}/></>}</button></div>
  </form></>;
}
