import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { SiteInputError } from './compile.mjs';

function denied(code, message) { throw new SiteInputError(code, message); }
function ipv4Public(ip) {
  const a = ip.split('.').map(Number);
  if (a.length !== 4 || a.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [x, y, z] = a;
  return !(x === 0 || x === 10 || x === 127 || x >= 224 ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && (y === 0 || y === 168 || (y === 88 && z === 99))) ||
    (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) ||
    (x === 203 && y === 0 && z === 113) ||
    (x === 192 && y === 0 && z === 2));
}
function publicIp(ip) {
  const family = isIP(ip);
  if (family === 4) return ipv4Public(ip);
  if (family === 6) {
    const value = ip.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:');
  }
  return false;
}
function siteUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { denied('INVALID_URL', 'A public company HTTPS URL is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      isIP(url.hostname) || !url.hostname.includes('.') ||
      /\.(local|internal|localhost)$/i.test(url.hostname) || url.hostname === 'localhost') {
    denied('INVALID_URL', 'Website collection is limited to public HTTPS hostnames');
  }
  url.hash = '';
  return url;
}
function sameHost(a, b) {
  return a.hostname.toLowerCase().replace(/^www\./, '') === b.hostname.toLowerCase().replace(/^www\./, '');
}
async function publicLookup(hostname) {
  let addresses;
  try { addresses = (await lookup(hostname, { all: true, verbatim: true })).map((row) => row.address); }
  catch { denied('DNS_FAILED', 'Company website DNS lookup failed'); }
  if (!addresses.length || addresses.some((ip) => !publicIp(ip))) {
    denied('PRIVATE_ADDRESS', 'Website resolves to an unsafe or non-public address');
  }
  return addresses;
}
async function pinnedGet(url, pin, byteLimit = 900_000) {
  if (!publicIp(pin)) denied('PRIVATE_ADDRESS', 'Unsafe pinned DNS address');
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    const call = request(url, {
      method: 'GET', timeout: 12000, servername: url.hostname,
      headers: { 'user-agent': 'BuyerSiteBuilder/0.1 (+review-only)',
        'accept': 'text/html,text/plain;q=0.7', 'accept-language': 'en,zh;q=0.6' },
      lookup(host, opts, done) {
        if (opts?.all) done(null, [{ address: pin, family: isIP(pin) }]);
        else done(null, pin, isIP(pin));
      },
    }, (response) => {
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > byteLimit) {
          call.destroy(); reject(new SiteInputError('SOURCE_TOO_LARGE', 'Website response exceeded the byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0, contentType: String(response.headers['content-type'] || ''),
        location: String(response.headers.location || ''), body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    call.on('timeout', () => call.destroy(new SiteInputError('SOURCE_TIMEOUT', 'Website fetch timed out')));
    call.on('error', (error) => reject(error instanceof SiteInputError ? error :
      new SiteInputError('SOURCE_FETCH_FAILED', 'Website fetch failed: ' + error.code)));
    call.end();
  });
}
export function robotsAllows(body, targetPath) {
  let applies = false;
  let matchedGroup = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const parts = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!parts) continue;
    const directive = parts[1].toLowerCase(), value = parts[2].trim();
    if (directive === 'user-agent') {
      if (matchedGroup && !applies) matchedGroup = false;
      applies = value === '*' || /^BuyerSiteBuilder$/i.test(value);
      matchedGroup = true;
    } else if (matchedGroup && applies && directive === 'disallow' && value) {
      if (value === '/' || targetPath.startsWith(value.replace(/\*.*$/, ''))) return false;
    }
  }
  return true;
}
async function fetchPinned(url, transport) {
  const first = await transport.lookup(url.hostname);
  if (!first.length || first.some((ip) => !publicIp(ip))) denied('PRIVATE_ADDRESS', 'Unsafe DNS result');
  const second = await transport.lookup(url.hostname);
  if (!second.length || second.some((ip) => !publicIp(ip))) denied('PRIVATE_ADDRESS', 'DNS rebinding detected');
  return transport.get(url, second[0]);
}
export function htmlText(html) {
  const cleaned = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|h1|h2|h3|li|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return cleaned
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim().slice(0, 30000);
}
export async function captureCompanyHomepage(rawUrl, transport = { lookup: publicLookup, get: pinnedGet }) {
  const origin = siteUrl(rawUrl);
  let target = origin;
  for (let i = 0; i < 3; i += 1) {
    const robotsUrl = new URL('/robots.txt', target);
    const robots = await fetchPinned(robotsUrl, transport);
    if (robots.status !== 404 && robots.status !== 410) {
      if (robots.status !== 200 || !robotsAllows(robots.body, target.pathname)) {
        denied('ROBOTS_BLOCKED', 'The public website did not authorize this route for collection');
      }
    }
    const response = await fetchPinned(target, transport);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      const next = siteUrl(new URL(response.location, target).href);
      if (!sameHost(next, origin)) denied('CROSS_DOMAIN_REDIRECT', 'Website redirects outside its own domain');
      target = next;
      continue;
    }
    if (response.status !== 200 || !/^text\/html/i.test(response.contentType)) {
      denied('SOURCE_FETCH_FAILED', 'Website did not return a readable HTML page');
    }
    const title = (response.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Company website').replace(/<[^>]+>/g, ' ').trim().slice(0, 200);
    const bodyText = htmlText(response.body);
    if (bodyText.length < 40) denied('EMPTY_SOURCE', 'Website does not contain enough rendered HTML text; manual review required');
    return { url: target.href, title, body_text: bodyText,
      content_sha256: createHash('sha256').update(bodyText).digest('hex'),
      captured_at: new Date().toISOString() };
  }
  denied('TOO_MANY_REDIRECTS', 'Website redirected more than twice');
}
