import { useEffect, useMemo, useRef, useState, type SubmitEvent } from 'react';
import {
  AuiIf, AssistantRuntimeProvider, ComposerPrimitive, ErrorPrimitive,
  MessagePrimitive, ThreadPrimitive, useAuiState, useLocalRuntime, type ChatModelAdapter,
} from '@assistant-ui/react';
import { conversion as copy } from '../../i18n/conversion';

type Props = { siteSlug: string; guideHref: string; enabled: boolean };

type SourceRecord = {
  id: string; title: string; claim: string; value: string; page_path: string;
  source_url: string; status: string; captured_at: string | null;
};

function SourceGuide({ siteSlug }: { siteSlug: string }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState('');
  async function search(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !query.trim()) return;
    setBusy(true); setError(''); setResults(null);
    try {
      const response = await fetch('/api/buyer/source-guide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ query: query.trim(), site_slug: siteSlug }), signal: AbortSignal.timeout(10_000),
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
            <div className="source-guide-links"><a href={record.page_path}>{copy.sourceGuideArticle}</a><a href={record.source_url} target="_blank" rel="noopener noreferrer">{copy.sourceGuideOriginal}</a></div>
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

function ConnectedThread() {
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
          body: JSON.stringify({ message: question, page_path: location.pathname, locale: document.documentElement.lang || 'en' }),
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
  }), []);
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

export default function SourcingAssistant({ siteSlug, guideHref, enabled }: Props) {
  const [status, setStatus] = useState<'checking' | 'connected' | 'source-guide'>(enabled ? 'checking' : 'source-guide');
  const [sourceGuide, setSourceGuide] = useState(false);
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
        {status === 'checking' ? copy.assistantChecking : status === 'connected' ? copy.assistantConnected : copy.assistantUnavailable}
      </p>
      {status === 'connected' && <ConnectedThread />}
      {status === 'source-guide' && sourceGuide && <SourceGuide siteSlug={siteSlug} />}
      <nav className="sourcing-next" aria-label="Sourcing resources">
        <a href="/search">{copy.search}</a><a href={guideHref}>{copy.guide}</a><a href="/enquiry">{copy.enquiry}</a>
      </nav>
    </div>
  );
}
