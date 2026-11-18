import { site } from '../config';
export function GET() {
  const body = site.privatePreview
    ? 'User-agent: *\nDisallow: /\n'
    : 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /enquiry/\nDisallow: /search/\nSitemap: ' + new URL('/sitemap-index.xml', site.url).href + '\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
