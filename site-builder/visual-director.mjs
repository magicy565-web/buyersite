import { createHash } from 'node:crypto';

// Deterministic visual direction. A future model may propose one of these profiles,
// but renderer inputs remain validated and never execute arbitrary generated code.
export const EDITORIAL_DIRECTIONS = Object.freeze(['atelier', 'industrial', 'editorial']);
const PALETTES = Object.freeze({
  atelier: { paper: '#e6dfd0', ground: '#d1bda4', ink: '#243b35', accent: '#ad6846', pale: '#f4eee2', line: '#736e5b' },
  industrial: { paper: '#dbe6e4', ground: '#9fb8be', ink: '#203849', accent: '#ef874e', pale: '#f0f4ed', line: '#4f7180' },
  editorial: { paper: '#e6e4dd', ground: '#c1bbb0', ink: '#22232b', accent: '#c72740', pale: '#f6f2e9', line: '#73717b' },
});

export function chooseEditorialDirection(categories = [], companyName = '') {
  const description = [...categories.filter((x) => typeof x === 'string'), companyName].join(' ').toLowerCase();
  if (/textile|fabric|garment|apparel|fashion|clothing|beauty|cosmetic|furniture|interior|homewear|leather|jewel|rayon|viscose|wool|cotton/.test(description)) return 'atelier';
  if (/industr|mechan|machin|metal|motor|tooling|electronic|component|automotiv|hardware|equipment|engineering|parts|steel/.test(description)) return 'industrial';
  return 'editorial';
}

export function planEditorialVisuals({ companyName = '', categories = [], articles = [] } = {}) {
  if (!Array.isArray(articles) || !Array.isArray(categories)) throw new TypeError('Invalid visual planning inputs');
  const direction = chooseEditorialDirection(categories, companyName);
  const seen = new Set();
  const images = articles.map((article, index) => {
    if (!article || typeof article.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(article.slug) || seen.has(article.slug)) {
      throw new TypeError('Visual asset slugs must be unique and path-safe');
    }
    seen.add(article.slug);
    return {
      page_id: article.slug,
      asset: `hero-${article.slug}.png`,
      source: 'original-abstract-illustration',
      composition: article.pageType === 'supplier-profile' ? 'portrait-feature' : article.pageType === 'buyer-guide' ? 'diagram' : 'material-study',
      sequence: index,
    };
  });
  return {
    schema_version: '1.0.0',
    direction,
    art_direction: direction === 'atelier' ? 'Warm material-led luxury editorial' : direction === 'industrial' ? 'Technical industrial field journal' : 'High-contrast contemporary editorial',
    source_policy: 'Only original abstract illustrations until supplier photography has documented publication rights',
    images,
  };
}

const hashNumber = (value) => parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16);

// No user-controlled text or external URLs enter the SVG. Art is deliberately
// abstract: it does not represent actual supplier products, facilities or certifications.
export function renderEditorialArtwork({ direction, pageId, sequence = 0, composition = 'material-study' }) {
  if (!EDITORIAL_DIRECTIONS.includes(direction)) throw new TypeError('Unknown editorial direction');
  if (typeof pageId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(pageId)) throw new TypeError('Invalid page ID');
  const p = PALETTES[direction];
  const seed = hashNumber(`${direction}:${pageId}:${sequence}`);
  const shift = seed % 240;
  const tilt = 210 + (seed % 160);
  const circleX = 850 + (seed % 490);
  const circleY = 270 + ((seed >>> 7) % 360);
  const stripe = Array.from({ length: 12 }, (_, i) => {
    const x = -260 + i * 178 + (shift % 40);
    return `<path d="M${x} 1067 L${x + tilt} 0" stroke="${p.line}" stroke-width="${i % 3 === 0 ? 3 : 1}" opacity=".30"/>`;
  }).join('');
  const hatch = Array.from({ length: 18 }, (_, i) => {
    const y = 80 + i * 52;
    return `<path d="M0 ${y} H1600" stroke="${p.pale}" stroke-width="1" opacity=".24"/>`;
  }).join('');
  const motif = composition === 'diagram'
    ? `<rect x="${380 + shift}" y="230" width="630" height="570" fill="none" stroke="${p.ink}" stroke-width="12"/><path d="M${420 + shift} 290 L${940 + shift} 735 M${420 + shift} 735 L${940 + shift} 290" stroke="${p.accent}" stroke-width="28"/><circle cx="${circleX}" cy="${circleY}" r="120" fill="${p.pale}"/>`
    : composition === 'portrait-feature'
      ? `<rect x="${520 + shift}" y="-90" width="430" height="1230" fill="${p.ink}" transform="rotate(-13 735 500)"/><rect x="${700 + shift}" y="45" width="340" height="950" fill="${p.pale}" opacity=".85"/><circle cx="${circleX}" cy="${circleY}" r="240" fill="${p.accent}"/>`
      : `<path d="M${260 + shift} -90 L${1000 + shift} -90 L${635 + shift} 1140 L${-90 + shift} 1140Z" fill="${p.ink}"/><path d="M${800 + shift} -60 L${1270 + shift} -60 L${965 + shift} 1140 L${535 + shift} 1140Z" fill="${p.accent}"/><circle cx="${circleX}" cy="${circleY}" r="185" fill="${p.pale}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067" viewBox="0 0 1600 1067" role="img" aria-label="Original abstract editorial illustration"><rect width="1600" height="1067" fill="${p.paper}"/><rect width="1600" height="1067" fill="${p.ground}" opacity=".35"/>${motif}<g>${stripe}${hatch}</g><rect x="32" y="32" width="1536" height="1003" fill="none" stroke="${p.ink}" stroke-width="3" opacity=".52"/><path d="M60 1000 H740" stroke="${p.accent}" stroke-width="16"/></svg>`;
}
