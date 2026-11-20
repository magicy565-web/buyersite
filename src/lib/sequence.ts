// The edition's page order: the order a reader turns through it, like a printed issue. The
// cover is page 1; the contents order follows (products, supplier, guide); the source notebook
// closes the edition. Folios and the page-turn controls both read from this one list, so a
// page number printed in a running head is always the page the turn controls land on.
import { getArticles, presentAll } from './content';

export interface EditionPage {
  path: string;
  title: string;
  section: string;
  folio: number;
}

let cached: EditionPage[] | null = null;
export async function editionSequence(): Promise<EditionPage[]> {
  if (cached) return cached;
  const items = await presentAll(await getArticles());
  const order = (type?: string) =>
    type === 'product-editorial' ? 0 : type === 'supplier-profile' ? 1 : type === 'buyer-guide' ? 2 : 3;
  const articles = [...items].sort(
    (a, b) => order(a.data.pageType) - order(b.data.pageType) || Number(b.data.featured) - Number(a.data.featured),
  );
  const pages = [
    { path: '/', title: 'Cover', section: 'Cover' },
    ...articles.map((item) => ({ path: item.href.replace(/\/?$/, '/'), title: item.data.title, section: item.desk.data.name })),
    { path: '/sources/', title: 'Source notebook', section: 'Sources' },
  ];
  cached = pages.map((page, index) => ({ ...page, folio: index + 1 }));
  return cached;
}

export async function pageInSequence(pathname: string) {
  const pages = await editionSequence();
  const key = (pathname.replace(/\/+$/, '') || '') + '/';
  const index = pages.findIndex((page) => page.path === (key === '//' ? '/' : key));
  if (index < 0) return { pages, current: null, previous: null, next: null };
  return {
    pages,
    current: pages[index],
    previous: index > 0 ? pages[index - 1] : null,
    next: index < pages.length - 1 ? pages[index + 1] : null,
  };
}
