import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { conversion as copy } from '../../i18n/conversion';
import type { BuyerBrief } from '../../lib/buyer-brief';
import { captureJourney, clearJourney, clearReceipt, findPublishedContext, privacyOptOut, readBriefHandoff, readReceipt, saveReceipt, type Journey } from '../../lib/buyer-journey.mjs';

type Props = { publishedContexts: BuyerBrief[]; allowedPaths: string[]; siteSlug: string; enabled: boolean };
type Receipt = { receipt_id: string; created_at: string; status: string; destination: string; supplier_sent: false };
type Requirements = { material: string; quantity: string; application: string; delivery: string };
type DraftSnapshot = { fields: Record<string, string>; context: BuyerBrief | null; questionIds: string[] };
const emptyRequirements = (): Requirements => ({ material: '', quantity: '', application: '', delivery: '' });

function storage() { try { return window.sessionStorage; } catch { return null; } }
function event(name: 'enquiry_started' | 'enquiry_submitted') {
  window.dispatchEvent(new CustomEvent('buyersite:event', { detail: { name, pagePath: location.pathname } }));
}

export default function EnquiryForm({ publishedContexts, allowedPaths, siteSlug, enabled }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const idempotency = useRef<string | null>(null);
  const started = useRef(false);
  const initialized = useRef(false);
  const [inbox, setInbox] = useState<'checking' | 'connected' | 'unavailable'>(enabled ? 'checking' : 'unavailable');
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [contextNotice, setContextNotice] = useState('');
  const [contextPath, setContextPath] = useState('');
  const [questionIds, setQuestionIds] = useState<string[]>([]);
  const [requirements, setRequirements] = useState<Requirements>(emptyRequirements);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [withheld, setWithheld] = useState(false);
  const confirmation = useRef<HTMLDivElement>(null);
  const savedDraft = useRef<DraftSnapshot | null>(null);
  const context = findPublishedContext(contextPath, publishedContexts);
  const restoredReceipt = Boolean(receipt && !savedDraft.current);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const session = storage();
    if (enabled) setReceipt(readReceipt(session, siteSlug));
    const optedOut = privacyOptOut();
    setWithheld(optedOut);
    const visit = enabled ? captureJourney(session, { siteSlug, allowedPaths,
      articlePaths: publishedContexts.map((item) => item.page_path), path: location.pathname,
      search: location.search, optedOut }) : null;
    setJourney(visit);
    const draft = readBriefHandoff(session, siteSlug, publishedContexts);
    const params = new URLSearchParams(location.search);
    const explicit = params.get('from');
    const selected = findPublishedContext(explicit ?? draft?.page_path ?? visit?.article_path, publishedContexts);
    if (explicit !== null && !selected) setContextNotice(copy.contextInvalid);
    if (!selected) return;
    setContextPath(selected.page_path);
    const matchingDraft = draft && findPublishedContext(draft.page_path, publishedContexts)?.page_path === selected.page_path ? draft : null;
    setRequirements({ ...emptyRequirements(), material: selected.product_name, ...(matchingDraft?.requirements ?? {}) });
    const requestedQuestion = params.get('question');
    const validQuestion = selected.questions.some((question) => question.id === requestedQuestion);
    setQuestionIds([...new Set([...(matchingDraft?.question_ids ?? []), ...(validQuestion && requestedQuestion ? [requestedQuestion] : [])])]);
    if (requestedQuestion && !validQuestion) setContextNotice(copy.contextQuestionInvalid);
    else if (matchingDraft) setContextNotice(copy.contextDraftLoaded);
  }, [enabled, siteSlug, allowedPaths, publishedContexts]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch('/api/buyer/config', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const config = await response.json();
        setInbox(config.site_slug === siteSlug && config.enquiries === true ? 'connected' : 'unavailable');
      })
      .catch(() => { if (!controller.signal.aborted) setInbox('unavailable'); });
    return () => controller.abort();
  }, [enabled, siteSlug]);
  useEffect(() => { if (receipt) confirmation.current?.focus(); }, [receipt]);

  function fields() {
    const data = new FormData(form.current!);
    return Object.fromEntries(['material', 'quantity', 'application', 'delivery', 'email', 'name', 'company', 'website']
      .map((key) => [key, String(data.get(key) ?? '').trim()]));
  }

  function selectContext(path: string) {
    const selected = findPublishedContext(path, publishedContexts);
    setContextPath(selected?.page_path ?? '');
    setQuestionIds([]);
    setContextNotice('');
    setRequirements((current) => ({ ...current, material: selected?.product_name ?? '' }));
    idempotency.current = null;
  }

  function removeVisit() {
    clearJourney(storage(), siteSlug);
    setJourney(null);
    setWithheld(true);
    idempotency.current = null;
  }

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending || receipt || inbox !== 'connected') return;
    const submitted = fields();
    const consent = new FormData(form.current!).get('consent') === 'yes';
    const optedOut = withheld || privacyOptOut();
    if (optedOut) { clearJourney(storage(), siteSlug); setJourney(null); setWithheld(true); }
    setError('');
    setNotice('');
    setSending(true);
    idempotency.current ??= crypto.randomUUID();
    try {
      const response = await fetch('/api/buyer/enquiries', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency.current },
        credentials: 'same-origin', signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ ...submitted, site_slug: siteSlug, page_path: location.pathname,
          consent, consent_version: 'buyer-enquiry-v1', context_page_path: context?.page_path ?? null,
          question_ids: questionIds, landing_page_path: optedOut ? null : journey?.landing_path ?? null,
          attribution: optedOut ? {} : journey?.campaign ?? {}, attribution_opt_out: optedOut }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.receipt_id !== 'string' || result.destination !== 'buyersite-editorial-inbox' || result.supplier_sent !== false) {
        throw new Error(typeof result.error?.message === 'string' ? result.error.message : copy.submissionError);
      }
      savedDraft.current = { fields: submitted, context, questionIds: [...questionIds] };
      saveReceipt(storage(), siteSlug, result);
      clearJourney(storage(), siteSlug);
      setJourney(null);
      setReceipt(result);
      event('enquiry_submitted');
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== 'TimeoutError' ? failure.message : copy.submissionError);
    } finally { setSending(false); }
  }

  function download() {
    const draft = receipt && savedDraft.current ? savedDraft.current : { fields: fields(), context, questionIds };
    const selectedQuestions = draft.context?.questions.filter((question) => draft.questionIds.includes(question.id)) ?? [];
    const receiptLines = receipt ? [`BUYERSITE ENQUIRY RECEIPT — ${receipt.receipt_id}`, `Received: ${receipt.created_at}`,
      'Saved to the Buyersite editorial sourcing inbox. No supplier message has been sent.',
      'The original brief and contact details were not retained in browser storage. This copy contains the receipt only.'] : [];
    const lines = restoredReceipt ? receiptLines : [
      receipt ? `BUYERSITE ENQUIRY — ${receipt.receipt_id}` : 'BUYERSITE ENQUIRY — UNSENT DRAFT',
      ...(draft.context ? [`Article: ${draft.context.title}`, `Article path: ${draft.context.page_path}`,
        ...(draft.context.source_url ? [`Published source: ${draft.context.source_url}`] : [])] : []),
      ...['material', 'quantity', 'application', 'delivery'].map((key) => `${key}: ${draft.fields[key] || '(not yet specified)'}`),
      ...selectedQuestions.map((question) => `${question.label}: ${question.prompt}`),
      copy.unknownTerms,
      receipt ? 'Saved to the Buyersite editorial sourcing inbox. No supplier message has been sent.' : 'This draft has not been submitted. No offer or availability is implied.',
    ];
    const href = URL.createObjectURL(new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = restoredReceipt ? 'buyersite-enquiry-receipt.txt' : receipt ? 'buyersite-enquiry.txt' : 'buyersite-enquiry-unsent.txt';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    setNotice(receipt ? copy.copyDownloaded : copy.draftDownloaded);
  }

  function restart() {
    clearReceipt(storage(), siteSlug);
    setReceipt(null); setError(''); setNotice('');
    idempotency.current = null; savedDraft.current = null; started.current = false;
    form.current?.reset();
    setRequirements({ ...emptyRequirements(), material: context?.product_name ?? '' });
    setQuestionIds([]);
    requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[name="material"]')?.focus());
  }

  return (
    <div className="enquiry-island">
      <p className="conversion-note" role="status">{inbox === 'checking' ? copy.checkingInbox : inbox === 'connected' ? copy.destination : copy.unavailable}</p>
      {receipt && <div className="enquiry-receipt" ref={confirmation} tabIndex={-1} role="status">
        <h2>{copy.savedTitle}</h2><p>{copy.savedDescription}</p>
        {restoredReceipt && <p>{copy.restoredReceipt}</p>}
        <dl><div><dt>{copy.reference}</dt><dd><code>{receipt.receipt_id}</code></dd></div>
          <div><dt>{copy.createdAt}</dt><dd><time dateTime={receipt.created_at}>{new Date(receipt.created_at).toLocaleString()}</time></dd></div></dl>
        <button type="button" className="conversion-secondary" onClick={restart}>{copy.another}</button>
      </div>}
      <form id="enquiry-form" ref={form} onSubmit={submit} className="conversion-form"
        onFocus={() => { if (!started.current) { started.current = true; event('enquiry_started'); } }}
        onChange={() => { if (!sending && !receipt) idempotency.current = null; }}>
        {!restoredReceipt && <>
        <fieldset disabled={sending || Boolean(receipt)}>
          <legend>{copy.contextLegend}</legend>
          <label htmlFor="enquiry-context">{copy.contextLabel}
            <select id="enquiry-context" className="conversion-input" value={contextPath} onChange={(e) => selectContext(e.target.value)}>
              <option value="">{copy.contextGeneral}</option>
              {publishedContexts.map((item) => <option key={item.page_path} value={item.page_path}>{item.title}</option>)}
            </select>
          </label>
          {contextNotice && <p className="conversion-note" role="status">{contextNotice}</p>}
          {context && <div className="enquiry-context">
            <div className="enquiry-context-links"><a href={context.page_path}>{copy.contextRead}</a>
              {context.source_url && <a href={context.source_url} target="_blank" rel="noopener noreferrer">{copy.contextSource}</a>}</div>
            <details className="enquiry-source-context"><summary>{copy.contextDetails}</summary>
              <p>{context.summary}</p><p className="conversion-note">{copy.contextDescription}</p>
              <h3>{copy.contextUnknown}</h3><ul>{context.unconfirmed.map((item) => <li key={item.id}><strong>{item.label}.</strong> {item.detail}</li>)}</ul>
            </details>
            <div className="enquiry-questions" role="group" aria-labelledby="enquiry-questions-label">
              <h3 id="enquiry-questions-label">{copy.contextQuestions}</h3>
              {context.questions.map((question) => <div className="enquiry-question" key={question.id}>
                <label className="conversion-consent">
                  <input type="checkbox" checked={questionIds.includes(question.id)} onChange={(e) => setQuestionIds((ids) => e.target.checked ? [...ids, question.id] : ids.filter((id) => id !== question.id))} />
                  <span>{question.label}</span>
                </label>
                <details className="enquiry-question-details">
                  <summary aria-label={`${copy.contextReadQuestion}: ${question.label}`}>{copy.contextReadQuestion}</summary>
                  <p className="enquiry-question-prompt">{question.prompt}</p>
                </details>
              </div>)}
            </div>
            <button type="button" className="conversion-secondary" onClick={() => selectContext('')}>{copy.contextClear}</button>
          </div>}
        </fieldset>
        <fieldset disabled={sending || Boolean(receipt)}>
          <legend>{copy.briefLegend}</legend>
          <label htmlFor="enquiry-material">{copy.material}
            <input id="enquiry-material" className="conversion-input" name="material" value={requirements.material} onChange={(e) => setRequirements({ ...requirements, material: e.target.value })} placeholder={copy.materialPlaceholder} maxLength={200} required />
          </label>
          <label htmlFor="enquiry-quantity">{copy.quantity}
            <input id="enquiry-quantity" className="conversion-input" name="quantity" value={requirements.quantity} onChange={(e) => setRequirements({ ...requirements, quantity: e.target.value })} placeholder={copy.quantityPlaceholder} maxLength={200} required />
          </label>
          <label htmlFor="enquiry-application">{copy.application}
            <textarea id="enquiry-application" className="conversion-input" name="application" value={requirements.application} onChange={(e) => setRequirements({ ...requirements, application: e.target.value })} placeholder={copy.applicationPlaceholder} maxLength={2000} rows={4} required />
          </label>
          <label htmlFor="enquiry-delivery">{copy.delivery}
            <input id="enquiry-delivery" className="conversion-input" name="delivery" value={requirements.delivery} onChange={(e) => setRequirements({ ...requirements, delivery: e.target.value })} placeholder={copy.deliveryPlaceholder} maxLength={300} required />
          </label>
        </fieldset>
        {enabled && <fieldset disabled={sending || Boolean(receipt)} className="enquiry-referral">
          <legend>{copy.referralTitle}</legend>
          {/* Shown on request: the desk's attribution data is the buyer's to inspect and remove,
              but it is not part of what they are asking for. */}
          <details className="enquiry-referral-details">
            <summary>{withheld ? copy.referralWithheldShort : journey ? copy.referralShow : copy.referralNone}</summary>
          {withheld ? <p className="conversion-note">{copy.referralWithheld}</p> : journey ? <>
            <p className="conversion-note">{copy.referralDescription}</p>
            <dl><div><dt>{copy.referralLanding}</dt><dd><a href={journey.landing_path}>{journey.landing_path}</a></dd></div>
              {Object.keys(journey.campaign).length > 0 && <div><dt>{copy.referralCampaign}</dt><dd>{Object.entries(journey.campaign).map(([key, value]) => `${key}: ${value}`).join(' · ')}</dd></div>}</dl>
            <button type="button" className="conversion-secondary" onClick={removeVisit}>{copy.referralRemove}</button>
          </> : <p className="conversion-note">{copy.referralUnavailable}</p>}
          </details>
        </fieldset>}
        {inbox === 'connected' && <fieldset disabled={sending || Boolean(receipt)}>
          <legend>{copy.contactLegend}</legend>
          <label htmlFor="enquiry-email">{copy.email}<input id="enquiry-email" className="conversion-input" name="email" type="email" autoComplete="email" maxLength={254} required /></label>
          <div className="conversion-field-pair">
            <label htmlFor="enquiry-name">{copy.name}<input id="enquiry-name" className="conversion-input" name="name" autoComplete="name" maxLength={100} /></label>
            <label htmlFor="enquiry-company">{copy.company}<input id="enquiry-company" className="conversion-input" name="company" autoComplete="organization" maxLength={160} /></label>
          </div>
          <div className="enquiry-trap" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
          <label className="conversion-consent"><input type="checkbox" name="consent" value="yes" required /><span>{copy.consent} <a href="/privacy">{copy.privacy}</a>.</span></label>
        </fieldset>}
        </>}
        {error && <p className="conversion-error" role="alert">{error}</p>}
        <div className="conversion-actions">
          {inbox === 'connected' && !receipt && <button type="submit" className="conversion-submit" disabled={sending}>{sending ? copy.submitting : copy.submit}</button>}
          <button type="button" className="conversion-secondary" onClick={download} disabled={sending}>{restoredReceipt ? copy.downloadReceipt : receipt ? copy.download : copy.downloadOnly}</button>
        </div>
        {notice && <p className="conversion-note" role="status">{notice}</p>}
      </form>
    </div>
  );
}
