import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { conversion as copy } from '../../i18n/conversion';

type Props = { productName: string; sourceUrl: string; siteSlug: string; enabled: boolean };
type Receipt = { receipt_id: string; created_at: string; status: string; destination: string; supplier_sent: false };

function event(name: 'enquiry_started' | 'enquiry_submitted') {
  window.dispatchEvent(new CustomEvent('buyersite:event', { detail: { name, pagePath: location.pathname } }));
}

export default function EnquiryForm({ productName, sourceUrl, siteSlug, enabled }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const idempotency = useRef<string | null>(null);
  const started = useRef(false);
  const [inbox, setInbox] = useState<'checking' | 'connected' | 'unavailable'>(enabled ? 'checking' : 'unavailable');
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const confirmation = useRef<HTMLDivElement>(null);
  // Preserve the submitted brief for receipt downloads after the fieldset is disabled.
  const savedFields = useRef<Record<string, string> | null>(null);

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

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending || receipt || inbox !== 'connected') return;
    // Read values before disabling the fieldset; disabled controls are omitted by FormData.
    const submitted = fields();
    const consent = new FormData(form.current!).get('consent') === 'yes';
    setError('');
    setNotice('');
    setSending(true);
    idempotency.current ??= crypto.randomUUID();
    const params = new URLSearchParams(location.search);
    const attribution = Object.fromEntries(['source', 'medium', 'campaign'].map((key) => [key, params.get('utm_' + key) ?? '']));
    try {
      const response = await fetch('/api/buyer/enquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency.current },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ ...submitted, site_slug: siteSlug, page_path: location.pathname,
          consent, consent_version: 'buyer-enquiry-v1', attribution }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.receipt_id !== 'string' || result.destination !== 'buyersite-editorial-inbox' || result.supplier_sent !== false) {
        throw new Error(typeof result.error?.message === 'string' ? result.error.message : copy.submissionError);
      }
      savedFields.current = submitted;
      setReceipt(result);
      event('enquiry_submitted');
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== 'TimeoutError' ? failure.message : copy.submissionError);
    } finally {
      setSending(false);
    }
  }

  function download() {
    const values = receipt && savedFields.current ? savedFields.current : fields();
    const lines = [
      receipt ? `BUYERSITE ENQUIRY — ${receipt.receipt_id}` : 'BUYERSITE ENQUIRY — UNSENT DRAFT',
      ...['material', 'quantity', 'application', 'delivery'].map((key) => `${key}: ${values[key] || '(not yet specified)'}`),
      copy.unknownTerms,
      `Background source: ${sourceUrl}`,
      receipt ? 'Saved to the Buyersite editorial sourcing inbox. No supplier message has been sent.' : 'This draft has not been submitted. No offer or availability is implied.',
    ];
    const href = URL.createObjectURL(new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = receipt ? 'buyersite-enquiry.txt' : 'buyersite-enquiry-unsent.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    setNotice(receipt ? copy.copyDownloaded : copy.draftDownloaded);
  }

  function restart() {
    setReceipt(null);
    setError('');
    setNotice('');
    idempotency.current = null;
    savedFields.current = null;
    started.current = false;
    form.current?.reset();
    requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[name="material"]')?.focus());
  }

  return (
    <div className="enquiry-island">
      <p className="conversion-note" role="status">{inbox === 'checking' ? copy.checkingInbox : inbox === 'connected' ? copy.destination : copy.unavailable}</p>
      {receipt && (
        <div className="enquiry-receipt" ref={confirmation} tabIndex={-1} role="status">
          <h2>{copy.savedTitle}</h2>
          <p>{copy.savedDescription}</p>
          <dl>
            <div><dt>{copy.reference}</dt><dd><code>{receipt.receipt_id}</code></dd></div>
            <div><dt>{copy.createdAt}</dt><dd><time dateTime={receipt.created_at}>{new Date(receipt.created_at).toLocaleString()}</time></dd></div>
          </dl>
          <button type="button" className="conversion-secondary" onClick={restart}>{copy.another}</button>
        </div>
      )}
      <form id="enquiry-form" ref={form} onSubmit={submit} className="conversion-form"
        onFocus={() => { if (!started.current) { started.current = true; event('enquiry_started'); } }}
        onChange={() => { if (!sending && !receipt) idempotency.current = null; }}>
        <fieldset disabled={sending || Boolean(receipt)}>
          <legend>{copy.briefLegend}</legend>
          <label htmlFor="enquiry-material">{copy.material}
            <input id="enquiry-material" className="conversion-input" name="material" defaultValue={productName} placeholder={copy.materialPlaceholder} maxLength={200} required />
          </label>
          <label htmlFor="enquiry-quantity">{copy.quantity}
            <input id="enquiry-quantity" className="conversion-input" name="quantity" placeholder={copy.quantityPlaceholder} maxLength={200} required />
          </label>
          <label htmlFor="enquiry-application">{copy.application}
            <textarea id="enquiry-application" className="conversion-input" name="application" placeholder={copy.applicationPlaceholder} maxLength={2000} rows={4} required />
          </label>
          <label htmlFor="enquiry-delivery">{copy.delivery}
            <input id="enquiry-delivery" className="conversion-input" name="delivery" placeholder={copy.deliveryPlaceholder} maxLength={300} required />
          </label>
        </fieldset>
        {inbox === 'connected' && (
          <fieldset disabled={sending || Boolean(receipt)}>
            <legend>{copy.contactLegend}</legend>
            <label htmlFor="enquiry-email">{copy.email}
              <input id="enquiry-email" className="conversion-input" name="email" type="email" autoComplete="email" maxLength={254} required />
            </label>
            <div className="conversion-field-pair">
              <label htmlFor="enquiry-name">{copy.name}<input id="enquiry-name" className="conversion-input" name="name" autoComplete="name" maxLength={100} /></label>
              <label htmlFor="enquiry-company">{copy.company}<input id="enquiry-company" className="conversion-input" name="company" autoComplete="organization" maxLength={160} /></label>
            </div>
            <div className="enquiry-trap" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
            <label className="conversion-consent"><input type="checkbox" name="consent" value="yes" required /><span>{copy.consent} <a href="/privacy">{copy.privacy}</a>.</span></label>
          </fieldset>
        )}
        {error && <p className="conversion-error" role="alert">{error}</p>}
        <div className="conversion-actions">
          {inbox === 'connected' && !receipt && <button type="submit" className="conversion-submit" disabled={sending}>{sending ? copy.submitting : copy.submit}</button>}
          <button type="button" className="conversion-secondary" onClick={download} disabled={sending}>{receipt ? copy.download : copy.downloadOnly}</button>
        </div>
        {notice && <p className="conversion-note" role="status">{notice}</p>}
      </form>
    </div>
  );
}
