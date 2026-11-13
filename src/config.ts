// src/config.ts — one presentation entry point for the pinned Halftone visual system.
// BUYERSITE_BUILD_ROOT selects a compiled enterprise edition; the pilot remains the default.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import defaultOgImage from './assets/editorial/cover.svg';

type BuilderSite = {
  slug: string; name: string; description: string; url: string; locale: string;
  author: string; supplierSlug: string; guideSlug: string; productName: string;
  sourceWebsite: string; privatePreview: boolean;
};
const editionRoot = process.env.BUYERSITE_BUILD_ROOT;
const edition: BuilderSite | null = editionRoot
  ? JSON.parse(readFileSync(resolve(editionRoot, 'site.json'), 'utf8')) as BuilderSite
  : null;

export const site = {
  name: edition?.name ?? 'Material Notes',
  description: edition?.description ??
    'A sourcing review for interior material buyers. Read the specifications, evidence and open questions before preparing an enquiry.',
  url: edition?.url ?? 'https://buyer-magazine.invalid',
  locale: edition?.locale ?? 'en',
  author: edition?.author ?? 'Material Notes editorial desk',
  slug: edition?.slug ?? 'material-notes',
  guideSlug: edition?.guideSlug ?? 'burel-project-brief',
  supplierSlug: edition?.supplierSlug ?? 'burel-factory',
  productName: edition?.productName ?? 'Burel Factory Silver wool fabric',
  sourceWebsite: edition?.sourceWebsite ?? 'https://burelfactory.com/en/products/prata',
  privatePreview: true,
  builderMode: Boolean(edition),
  defaultOgImage,
} as const;

export const nav = {
  header: edition
    ? [
        ...(edition.productName ? [{ label: 'Products', href: '/products' }] : []),
        { label: 'Supplier', href: '/suppliers/' + edition.supplierSlug },
        { label: 'Buying guide', href: '/guides/' + edition.guideSlug },
      ]
    : [
        { label: 'Materials', href: '/materials' },
        { label: 'Supplier', href: '/suppliers/burel-factory' },
        { label: 'Buying guide', href: '/guides/burel-project-brief' },
      ],
  footer: [
    {
      title: 'More',
      links: [
        { label: 'Sources & scope', href: '/colophon' },
        { label: 'Feed', href: '/rss.xml' },
      ],
    },
  ],
  social: [] as { label: string; href: string; icon: string }[],
};

export const seo = {
  titleTemplate: '%s · ' + site.name,
  twitterHandle: '',
  jsonLd: { type: 'Organization' as 'Person' | 'Organization', name: site.author },
};

export const coverLines = {
  overlay: false,
  divider: 'plus' as 'plus' | 'rule' | 'none',
  max: 1,
};

export const blog = {
  postsPerPage: 4,
  relatedPosts: 3,
  showReadingTime: true,
};

export const features = { darkMode: true };

export const analytics = {
  provider: null as null | 'plausible' | 'ga4' | 'umami',
  id: '',
  host: '',
};
