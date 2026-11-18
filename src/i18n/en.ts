// The chrome, in English. These are the words the theme puts on a page that the writing did
// not: labels, counts, navigation. The standing prose on the colophon, the archive and the
// other index pages is not here on purpose -- that copy is yours to rewrite in the page it
// belongs to, and a magazine's about-page voice does not belong in a string table.
//
// Interpolated strings are functions so a translation can put the number where its own
// grammar wants it, and so plural rules stay with the language that has them.
export default {
  askSourcing: 'Ask a sourcing question',
  prepareEnquiry: 'Prepare an enquiry',
  enquiryNav: 'Enquiry',
  sourcingNav: 'Sourcing desk',
  reviewMaterial: 'Review the material',
  sourceNotes: 'Specifications and source notes',
  supplierSource: 'Supplier source',
  supplierStated: 'Supplier-stated',
  reviewDate: 'Reviewed November 12, 2026',
  unknownTerms:
    'MOQ, trade pricing, availability and project delivery require a current written offer.',
  editorial: {
    readStory: 'Read the sourcing review',
    supplierFeature: 'Supplier profile',
    supplierScope: 'A starting point for supplier evaluation. Check the source notes and request project-specific evidence.',
    reviewSupplierSources: 'Review the supplier and sources',
    specificationHeading: 'Material review',
    specificationTitle: 'Start with what the source tells you',
    specificationScope: 'Read the stated specification, see what remains open and carry the right questions into your enquiry.',
    specificationMissing: 'No product specification is available yet. Request the technical sheet before comparing offers.',
    readSpecification: 'Read the specification and evidence',
    commercialScope: 'Source-stated information. MOQ, trade price, availability and delivery need a current written offer.',
    buyingGuide: 'Prepare to source',
    checklistTitle: 'A better brief starts with four questions',
    checklistIntro: 'Put the application, quantity, evidence and commercial terms in the same brief so suppliers can respond on a comparable basis.',
    readBuyingGuide: 'Read the buying guide',
    checkUseTitle: 'What will it be used for?',
    checkUseDetail: 'Describe the application, dimensions, finish and conditions the product needs to meet.',
    checkQuantityTitle: 'How much, and by when?',
    checkQuantityDetail: 'Include quantities and units, the delivery destination and the target date.',
    checkEvidenceTitle: 'What needs to be checked?',
    checkEvidenceDetail: 'Ask for relevant technical sheets, samples and applicable test documents. Note anything still unconfirmed.',
    checkTermsTitle: 'What should the offer include?',
    checkTermsDetail: 'Request the price and currency, minimum order, lead time, packing and delivery terms in writing.',
    moreProducts: 'More products to review',
    browseDesk: 'Browse this section',
    moreReading: 'Continue reading',
    homePurpose: 'Compare materials and suppliers with the source details in view. Build an enquiry around what is known and what still needs an answer.',
    readingRoute: 'Find what you need',
    materialRoute: 'Material and specification',
    supplierRoute: 'Supplier background',
    guideRoute: 'Build your buying brief',
    carryContext: 'Keep this review with your enquiry',
    knownHeading: 'Source-backed details',
    openHeading: 'Still to confirm',
    questionsHeading: 'Questions to take to the supplier',
    questionsIntro: 'Choose a question to carry into your enquiry, then add the requirements of your project.',
    useQuestion: 'Use this question',
    noEvidence: 'No product-specific evidence is attached to this review. Request the relevant documents before treating a statement as a specification.',
    evidenceScope: 'These are statements from the listed sources. A source citation does not establish an independent test or a supplier endorsement.',
    supplierStatement: 'Supplier statement',
    enterpriseRecord: 'Company record',
    sourceDate: 'Source checked',
    dateUnavailable: 'Check date unavailable',
    readEvidence: 'Read the sources',
    readSource: 'Open source',
    onThisPage: 'In this review',
    jumpDetails: 'Details and open points',
    jumpQuestions: 'Questions to ask',
    jumpSources: 'Source notes',
    briefSummary: 'Before you request an offer',
  },
  // Layout
  skip: 'Skip to content',
  desks: 'Desks', // the header nav, named for what is in it

  // Counts and datelines. `stories` is what a folio counts.
  by: 'By',
  minutes: (n: number) => `${n} min`,
  stories: (n: number) => `${n} ${n === 1 ? 'story' : 'stories'}`,

  // The article and its rail
  figures: 'By the numbers',
  moreFrom: (desk: string) => `More from ${desk}`,
  filedTo: 'Filed to',
  relatedReading: 'Related reading',

  // Fronts and paging
  photoEssay: 'Photo essay',
  pagination: 'Pagination',
  newer: '← Newer',
  older: 'Older →',
  pageOf: (n: number, total: number) => `Page ${n} of ${total}`,

  // 404
  notFound: 'Page not found',
  notFoundLine: 'The page you asked for is not here.',
  backHome: 'Back to the home page',
};
