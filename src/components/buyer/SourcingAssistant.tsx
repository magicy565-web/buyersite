import { useEffect, useMemo, useRef, useState, type SubmitEvent } from 'react';
import {
  AuiIf, AssistantRuntimeProvider, ComposerPrimitive, ErrorPrimitive,
  MessagePrimitive, ThreadPrimitive, useAuiState, useLocalRuntime, type ChatModelAdapter,
} from '@assistant-ui/react';
import { conversion as copy } from '../../i18n/conversion';
import { sourcing as desk } from '../../i18n/sourcing';
import type { BuyerBrief } from '../../lib/buyer-brief';
import { saveBriefHandoff } from '../../lib/buyer-journey.mjs';

type Props = { siteSlug: string; guideHref: string; enabled: boolean; briefs: BuyerBrief[]; initialPath: string };
const pathKey = (path: string) => path.replace(/\/+$/, '') || '/';

type SourceRecord = {
  id: string; title: string; claim: string; value: string; page_path: string;
  source_url: string; status: string; captured_at: string | null;
};

function SourceGuide({ siteSlug, brief, onUseArticle }: { siteSlug: string; brief: BuyerBrief | null; onUseArticle: (path: string) => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setResults(null); setError(''); }, [brief?.page_path]);
  async function search(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !query.trim()) return;
    setBusy(true); setError(''); setResults(null);
    try {
      const response = await fetch('/api/buyer/source-guide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ query: query.trim(), site_slug: siteSlug, ...(brief ? { page_path: brief.page_path } : {}) }), signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json();
      if (!response.ok || data.mode !== 'source-guide' || !Array.isArray(data.results)) throw new Error(copy.sourceGuideError);
      setResults(data.results);
      window.dispatchEvent(new CustomEvent('buyersite:event', { detail: { name: 'search_used', pagePath: location.pathname } }));
    } catch { setError(copy.sourceGuideError); }
    finally { setBusy(false); }
  }
  return (
    <section className="source-guide" aria-labelledby="source-guide-title">
      <h3 id="source-guide-title">{copy.sourceGuideTitle}</h3>
      <p className="conversion-note">{copy.sourceGuideExplanation}</p>
      <form onSubmit={search} className="sourcing-composer">
        <label htmlFor="source-guide-query">{copy.sourceGuideQuery}</label>
        <input id="source-guide-query" className="conversion-input" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.sourceGuidePlaceholder} maxLength={200} required disabled={busy} />
        <div className="conversion-actions"><button type="submit" className="conversion-submit" disabled={busy}>{busy ? copy.sourceGuideSearching : copy.sourceGuideSubmit}</button></div>
      </form>
      {error && <p className="conversion-error" role="alert">{error}</p>}
      {results && <div className="source-guide-results" aria-live="polite">
        {results.length === 0 ? <p className="conversion-note">{copy.sourceGuideEmpty}</p> : <>
          <h4>{copy.sourceGuideResults}</h4>
          <ul>{results.map((record) => <li key={record.id + record.page_path}>
            <p className="source-guide-claim">{record.claim}</p>
            <p>{record.value}</p>
            <p className="source-guide-meta">{record.status.replaceAll('-', ' ')}{record.captured_at && !Number.isNaN(Date.parse(record.captured_at)) ? ` · ${copy.sourceGuideReviewed} ${record.captured_at.slice(0, 10)}` : ''}</p>
            <div className="source-guide-links"><a href={record.page_path}>{copy.sourceGuideArticle}</a><a href={record.source_url} target="_blank" rel="noopener noreferrer">{copy.sourceGuideOriginal}</a>
              {(!brief || pathKey(brief.page_path) !== pathKey(record.page_path)) && <button type="button" onClick={() => onUseArticle(record.page_path)}>{desk.useArticle}</button>}
            </div>
          </li>)}</ul>
        </>}
      </div>}
    </section>
  );
}

function ConversationMessage() {
  const isUser = useAuiState((state) => state.message.role === 'user');
  return (
    <MessagePrimitive.Root className={isUser ? 'sourcing-message sourcing-message-user' : 'sourcing-message'}>
      <p className="sourcing-message-label">{isUser ? copy.assistantYou : copy.assistantLabel}</p>
      <MessagePrimitive.Parts />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="conversion-error"><ErrorPrimitive.Message /></ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

function ConnectedThread({ pagePath }: { pagePath: string }) {
  const session = useRef<string | null>(null);
  const adapter = useMemo<ChatModelAdapter>(() => ({
    async run({ messages, abortSignal }) {
      const last = [...messages].reverse().find((message) => message.role === 'user');
      const question = last?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
      if (!question) throw new Error(copy.assistantMissingQuestion);
      let response: Response;
      try {
        response = await fetch('/api/buyer/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(session.current ? { 'X-Buyer-Session': session.current } : {}) },
          credentials: 'same-origin',
          signal: AbortSignal.any([abortSignal, AbortSignal.timeout(25_000)]),
          body: JSON.stringify({ message: question, page_path: pagePath, locale: document.documentElement.lang || 'en' }),
        });
      } catch (error) {
        if (abortSignal.aborted) throw error;
        throw new Error(copy.assistantError);
      }
      const data = await response.json();
      if (response.status === 401) { session.current = null; throw new Error(copy.assistantNewSession); }
      if (!response.ok || typeof data.answer !== 'string' || typeof data.session_id !== 'string') {
        throw new Error(typeof data.error?.message === 'string' ? data.error.message : copy.assistantError);
      }
      session.current = data.session_id;
      return { content: [{ type: 'text', text: data.answer }] };
    },
  }), [pagePath]);
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="sourcing-thread">
        <ThreadPrimitive.Viewport className="sourcing-transcript" role="log" aria-live="polite" aria-label={copy.assistantTitle}>
          <AuiIf condition={(state) => state.thread.isEmpty}><p className="sourcing-empty">{copy.assistantEmpty}</p></AuiIf>
          <ThreadPrimitive.Messages>{() => <ConversationMessage />}</ThreadPrimitive.Messages>
          <AuiIf condition={(state) => state.thread.isRunning}><p className="conversion-note" role="status">{copy.assistantLoading}</p></AuiIf>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="sourcing-composer">
          <label htmlFor="assistant-question">{copy.assistantQuestion}</label>
          <ComposerPrimitive.Input id="assistant-question" className="conversion-input" placeholder={copy.assistantPlaceholder} maxLength={2000} rows={3} submitMode="ctrlEnter" />
          <div className="conversion-actions">
            <ComposerPrimitive.Send className="conversion-submit">{copy.assistantSend}</ComposerPrimitive.Send>
            <AuiIf condition={(state) => state.thread.isRunning}><ComposerPrimitive.Cancel className="conversion-secondary">{copy.assistantStop}</ComposerPrimitive.Cancel></AuiIf>
          </div>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function BriefComposer({ siteSlug, brief, contexts }: { siteSlug: string; brief: BuyerBrief; contexts: BuyerBrief[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [requirements, setRequirements] = useState({ quantity: '', application: '', delivery: '' });
  const [error, setError] = useState('');
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open) title.current?.focus(); }, [open]);
  const enquiryHref = '/enquiry?from=' + encodeURIComponent(brief.page_path);
  function review(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    let saved = false;
    try {
      saved = saveBriefHandoff(sessionStorage, { version: 1, site_slug: siteSlug, page_path: brief.page_path, question_ids: selected, requirements }, contexts);
    } catch { /* Keep the draft visible if browser storage is unavailable. */ }
    if (!saved) { setError(desk.storageError); return; }
    location.assign(enquiryHref);
  }
  if (!open) return <div className="sourcing-brief"><button type="button" className="conversion-submit" onClick={() => setOpen(true)}>{desk.prepare}</button></div>;
  return <section className="sourcing-brief" aria-labelledby="sourcing-brief-title">
    <h3 id="sourcing-brief-title" tabIndex={-1} ref={title}>{desk.briefTitle}</h3>
    <p className="conversion-note">{desk.briefHint}</p>
    <form className="sourcing-brief-form" onSubmit={review}>
      <fieldset><legend>{desk.chooseQuestions}</legend>
        {brief.questions.map((question) => <label className="sourcing-brief-question" key={question.id}>
          <input type="checkbox" checked={selected.includes(question.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, question.id] : selected.filter((id) => id !== question.id))} />
          <span>{question.label}</span>
        </label>)}
      </fieldset>
      <label htmlFor="desk-quantity">{desk.quantity}</label>
      <input id="desk-quantity" className="conversion-input" maxLength={200} value={requirements.quantity} placeholder={desk.quantityPlaceholder} onChange={(event) => setRequirements({ ...requirements, quantity: event.target.value })} />
      <label htmlFor="desk-application">{desk.application}</label>
      <textarea id="desk-application" className="conversion-input" rows={3} maxLength={2000} value={requirements.application} placeholder={desk.applicationPlaceholder} onChange={(event) => setRequirements({ ...requirements, application: event.target.value })} />
      <label htmlFor="desk-delivery">{desk.delivery}</label>
      <input id="desk-delivery" className="conversion-input" maxLength={300} value={requirements.delivery} placeholder={desk.deliveryPlaceholder} onChange={(event) => setRequirements({ ...requirements, delivery: event.target.value })} />
      {error && <p className="conversion-error" role="alert">{error} <a href={enquiryHref}>{desk.openEnquiry}</a></p>}
      <div className="sourcing-brief-actions">
        <button type="submit" className="conversion-submit">{desk.review}</button>
        <button type="button" className="conversion-secondary" onClick={() => { setSelected([]); setRequirements({ quantity: '', application: '', delivery: '' }); setError(''); }}>{desk.reset}</button>
        <button type="button" className="conversion-secondary" onClick={() => setOpen(false)}>{desk.cancel}</button>
      </div>
      <p className="conversion-note">{desk.reviewHint}</p>
    </form>
  </section>;
}

export default function SourcingAssistant({ siteSlug, guideHref, enabled, briefs, initialPath }: Props) {
  const [status, setStatus] = useState<'checking' | 'connected' | 'source-guide'>(enabled ? 'checking' : 'source-guide');
  const [sourceGuide, setSourceGuide] = useState(false);
  const [activePath, setActivePath] = useState(briefs.find((brief) => pathKey(brief.page_path) === pathKey(initialPath))?.page_path ?? '');
  const brief = briefs.find((item) => pathKey(item.page_path) === pathKey(activePath)) ?? null;
  function selectContext(path: string) { setActivePath(briefs.find((item) => pathKey(item.page_path) === pathKey(path))?.page_path ?? ''); }
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch('/api/buyer/config', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const config = await response.json();
        setStatus(enabled && config.site_slug === siteSlug && config.assistant === true ? 'connected' : 'source-guide');
        setSourceGuide(config.site_slug === siteSlug && config.source_guide === true);
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('source-guide'); });
    return () => controller.abort();
  }, [enabled, siteSlug]);
  return (
    <div className="sourcing-assistant" data-assistant-mode={status}>
      <p id="assistant-status" className="conversion-note" role="status">
        {status === 'checking' ? copy.assistantChecking : status === 'connected' ? copy.assistantConnected : desk.factsReady}
      </p>
      {briefs.length > 0 && <div className="sourcing-context">
        <label htmlFor="sourcing-reading">{desk.context}</label>
        <select id="sourcing-reading" className="conversion-input" value={activePath} onChange={(event) => selectContext(event.target.value)}>
          <option value="">{desk.allSources}</option>
          {briefs.map((item) => <option key={item.page_path} value={item.page_path}>{item.title}</option>)}
        </select>
        <p className="conversion-note">{desk.contextHint}</p>
      </div>}
      {status === 'connected' && <ConnectedThread key={activePath} pagePath={brief?.page_path ?? '/'} />}
      {status === 'source-guide' && sourceGuide && <SourceGuide key={activePath} siteSlug={siteSlug} brief={brief} onUseArticle={selectContext} />}
      {brief && <>
        <details className="sourcing-unknowns"><summary>{desk.questions}</summary>
          <p className="conversion-note">{desk.questionsHint}</p>
          <dl>{brief.unconfirmed.map((condition) => <div key={condition.id}><dt>{condition.label}</dt><dd>{condition.detail}</dd></div>)}</dl>
        </details>
        <BriefComposer key={brief.page_path} siteSlug={siteSlug} brief={brief} contexts={briefs} />
      </>}
      {!brief && briefs.length > 0 && <p className="conversion-note">{desk.noBrief}</p>}
      <nav className="sourcing-next" aria-label="Sourcing resources">
        <a href="/sources">{desk.sources}</a><a href={guideHref}>{copy.guide}</a><a href={brief ? '/enquiry?from=' + encodeURIComponent(brief.page_path) : '/enquiry'}>{copy.enquiry}</a>
      </nav>
    </div>
  );
}
