import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCurrentLicensedSelection } from './media-rights.mjs';
import { normalizeLicensedPhoto } from './media-render.mjs';

export const MEDIA_REVIEW_POLICY = 'buyer-media-review/v1';
export const mediaHash = (value) => createHash('sha256').update(value).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const safeText = (value, limit = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const fail = (code) => { const error = Error(code); error.code = code; throw error; };

// The page review binds the complete rendered site separately. This binding
// covers the actual image, its provenance, and the exact intended use/disclosure.
export function mediaReviewBinding({ page, asset }) {
  if (!page || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(page.page_id || '') ||
      !/^\/(?:[a-z0-9-]+\/)*$/.test(page.path || '') || !safeText(page.title, 300) ||
      !asset || asset.page_id !== page.page_id || !HEX.test(asset.sha256 || '') ||
      !['licensed-photo', 'ai-generated', 'abstract-fallback'].includes(asset.kind) ||
      !safeText(asset.alt, 300) || !safeText(asset.credit, 300) || !safeText(asset.caption)) fail('MEDIA_REVIEW_BINDING_INVALID');
  if (asset.kind === 'ai-generated' && (!HEX.test(asset.prompt_sha256 || '') ||
      !safeText(asset.generation_model, 160) || !safeText(asset.generation_provider, 160))) fail('MEDIA_REVIEW_PROVENANCE_MISSING');
  if (asset.kind === 'licensed-photo' && (!HEX.test(asset.source_sha256 || '') ||
      !HEX.test(asset.grant_sha256 || '') || !HEX.test(asset.rights_sha256 || ''))) fail('MEDIA_REVIEW_PROVENANCE_MISSING');
  return {
    policy: MEDIA_REVIEW_POLICY, page_id: page.page_id, path: page.path, title: page.title,
    kind: asset.kind, image_sha256: asset.sha256, prompt_sha256: asset.prompt_sha256 || null,
    generation_model: asset.generation_model || null, generation_provider: asset.generation_provider || null,
    source_sha256: asset.source_sha256 || null, grant_sha256: asset.grant_sha256 || null,
    rights_sha256: asset.rights_sha256 || null, alt: asset.alt, credit: asset.credit, caption: asset.caption,
  };
}

export function passingVisualAssessment(assessment) {
  return assessment?.decision === 'pass' &&
    ['editorial_quality', 'hierarchy', 'mobile_readability', 'authenticity']
      .every((field) => Number.isInteger(assessment[field]) && assessment[field] >= 4 && assessment[field] <= 5) &&
    Array.isArray(assessment.issues) && assessment.issues.length <= 12 &&
    assessment.issues.every((issue) => issue?.severity === 'minor' && safeText(issue.problem, 500) && safeText(issue.recommendation, 500));
}

export function passingMediaAssessment(assessment) {
  return assessment?.decision === 'pass' &&
    ['visual_quality', 'contextual_fit', 'authenticity']
      .every((field) => Number.isInteger(assessment[field]) && assessment[field] >= 4 && assessment[field] <= 5) &&
    Array.isArray(assessment.issues) && assessment.issues.length <= 12 &&
    assessment.issues.every((issue) => issue?.severity === 'minor' && safeText(issue.problem, 500) && safeText(issue.recommendation, 500));
}

// Call only after an AI has actually inspected the pixels. This records an
// observation; it never creates a verdict from provenance metadata or hashes.
export function mediaReviewReceipt({ binding, assessment, method, reviewer, model,
  reviewedAt = new Date().toISOString(), evidenceType = 'observed', notes }) {
  return {
    policy: MEDIA_REVIEW_POLICY, binding_sha256: mediaHash(JSON.stringify(binding)),
    image_sha256: binding.image_sha256, page_id: binding.page_id, path: binding.path,
    decision: passingMediaAssessment(assessment) ? 'pass' : assessment?.decision === 'reject' ? 'reject' : 'revise',
    reviewer_type: 'ai', method, reviewer, model, reviewed_at: reviewedAt,
    evidence_type: evidenceType, human_approval_required: false, assessment, notes,
  };
}

export function assertMediaReview({ binding, review, asOf = new Date().toISOString() }) {
  if (!review) fail('MEDIA_REVIEW_MISSING');
  if (review.policy !== MEDIA_REVIEW_POLICY || review.binding_sha256 !== mediaHash(JSON.stringify(binding)) ||
      review.image_sha256 !== binding.image_sha256 || review.page_id !== binding.page_id || review.path !== binding.path) fail('MEDIA_REVIEW_STALE');
  if (review.decision !== 'pass' || !passingMediaAssessment(review.assessment)) fail('MEDIA_REVIEW_REJECTED');
  if (review.reviewer_type !== 'ai' || !['interactive-vision', 'openai-responses'].includes(review.method) ||
      review.evidence_type !== 'observed' || !safeText(review.reviewer, 160) || !safeText(review.model, 160) ||
      !safeText(review.notes, 2000) || typeof review.reviewed_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(review.reviewed_at) || !Number.isFinite(Date.parse(review.reviewed_at)) ||
      !Number.isFinite(Date.parse(asOf)) || Date.parse(review.reviewed_at) > Date.parse(asOf)) fail('MEDIA_REVIEW_EVIDENCE_INVALID');
  return true;
}

export function assertReviewedMedia({ page, asset, bytes, asOf }) {
  if (!Buffer.isBuffer(bytes) || mediaHash(bytes) !== asset?.sha256) fail('MEDIA_IMAGE_HASH_MISMATCH');
  if (asset.kind === 'abstract-fallback') fail('MEDIA_FALLBACK_PREVIEW_ONLY');
  if (asset.kind === 'ai-generated') {
    if (!safeText(asset.prompt, 8000) || mediaHash(asset.prompt) !== asset.prompt_sha256) fail('MEDIA_PROMPT_HASH_MISMATCH');
    if (!/AI-generated/i.test(asset.credit + ' ' + asset.caption) || !/concept/i.test(asset.caption) ||
        !/(?:does not depict|not a depiction|not (?:a supplier |product )?photograph)/i.test(asset.caption)) fail('MEDIA_DISCLOSURE_REQUIRED');
  }
  const binding = mediaReviewBinding({ page, asset });
  assertMediaReview({ binding, review: asset.review, asOf });
  return binding;
}

export async function editionReviewSource({ sourceRoot, mediaRoot = process.env.BUYERSITE_MEDIA_ROOT, asOf }) {
  const [pages, mediaPlan, mediaReport] = await Promise.all(['pages.json', 'media-plan.json', 'media-report.json']
    .map(async (file) => JSON.parse(await readFile(join(sourceRoot, file), 'utf8'))));
  if (!Array.isArray(pages) || !Array.isArray(mediaPlan.selections) || !Array.isArray(mediaReport.images) ||
      mediaPlan.plan_sha256 !== mediaHash(JSON.stringify(mediaPlan.selections)) || mediaReport.plan_sha256 !== mediaPlan.plan_sha256 ||
      mediaReport.images.length !== pages.length - 1 || mediaPlan.selections.length !== mediaReport.images.length ||
      new Set(mediaReport.images.map((image) => image?.page_id)).size !== mediaReport.images.length) fail('MEDIA_REVIEW_SOURCE_INVALID');
  const bindings = [];
  for (const asset of mediaReport.images) {
    const page = pages.find((entry) => entry.page_id === asset.page_id);
    const selected = mediaPlan.selections.find((entry) => entry.page_id === asset.page_id);
    if (!page || !selected || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(asset.page_id || '') ||
        asset.filename !== 'hero-' + asset.page_id + '.png') fail('MEDIA_REVIEW_SOURCE_INVALID');
    const bytes = await readFile(join(sourceRoot, 'articles', asset.filename));
    if (mediaHash(bytes) !== asset.sha256) fail('MEDIA_IMAGE_HASH_MISMATCH');
    if (asset.kind === 'licensed-photo') {
      const receipt = JSON.parse(await readFile(join(sourceRoot, 'receipt.json'), 'utf8'));
      if (selected.media_kind !== 'licensed-photo' || asset.source_sha256 !== selected.source_sha256 ||
          asset.grant_sha256 !== selected.grant_sha256 || asset.rights_sha256 !== selected.rights_sha256) fail('MEDIA_REVIEW_SOURCE_INVALID');
      const { sourceBytes } = await assertCurrentLicensedSelection({ asset: selected, enterpriseId: receipt.enterprise_id, mediaRoot, asOf });
      if (mediaHash(await normalizeLicensedPhoto(sourceBytes)) !== asset.sha256) fail('MEDIA_LICENSED_DERIVATION_MISMATCH');
    } else if (selected.media_kind !== 'generation-requested') fail('MEDIA_REVIEW_SOURCE_INVALID');
    if (asset.kind === 'ai-generated' && (typeof asset.prompt !== 'string' || mediaHash(asset.prompt) !== asset.prompt_sha256)) fail('MEDIA_PROMPT_HASH_MISMATCH');
    bindings.push(mediaReviewBinding({ page, asset }));
  }
  return { pages, mediaReport, bindings, source_sha256: mediaHash(JSON.stringify({ pages, plan_sha256: mediaPlan.plan_sha256, bindings })) };
}

// A publisher may consume a completed automated or interactive AI page review.
// This gate does not grant publication permission or lift tenant privacy.
export async function assertEditionVisualReview({ review, sourceRoot, artifactSha256, jobDir, mediaRoot, asOf }) {
  if (!review || review.status !== 'PASS_RECOMMENDED' || review.evidence_type !== 'observed' ||
      !['interactive-vision', 'openai-responses'].includes(review.review_method) || !passingReviewTime(review.reviewed_at, asOf)) fail('EDITION_REVIEW_REQUIRED');
  const current = await editionReviewSource({ sourceRoot, mediaRoot, asOf });
  if (!HEX.test(artifactSha256 || '') || review.artifact_sha256 !== artifactSha256 ||
      review.source_sha256 !== current.source_sha256 || JSON.stringify(review.media_bindings) !== JSON.stringify(current.bindings)) fail('EDITION_REVIEW_STALE');
  if (review.coverage?.complete !== true || review.coverage.reviewed_pages !== current.pages.length ||
      review.coverage.expected_pages !== current.pages.length || !Array.isArray(review.pages) || review.pages.length !== current.pages.length ||
      current.mediaReport.images.some((asset) => asset.kind === 'abstract-fallback')) fail('EDITION_REVIEW_INCOMPLETE');
  for (const page of current.pages) {
    const matches = review.pages.filter((entry) => entry.page_id === page.page_id && entry.path === page.path);
    const entry = matches[0];
    if (matches.length !== 1 || entry.status !== 'PASS_RECOMMENDED' || !passingVisualAssessment(entry.assessment) ||
        !Array.isArray(entry.screenshots) || entry.screenshots.length < 2 ||
        !['desktop', 'mobile'].every((name) => entry.screenshots.some((shot) => shot.viewport === name))) fail('EDITION_REVIEW_INCOMPLETE');
    for (const shot of entry.screenshots) {
      if (!new RegExp('^' + page.page_id + '-(?:desktop|mobile)(?:-(?:[2-9]|1[0-2]))?\\.png$').test(shot.private_file || '') ||
          !HEX.test(shot.sha256 || '') || mediaHash(await readFile(join(jobDir, 'visual-review/screenshots', shot.private_file))) !== shot.sha256) fail('EDITION_REVIEW_SCREENSHOT_CHANGED');
    }
  }
  return { media_review_complete: true, human_approval_required: false, publication_permission: 'SEPARATE_GATE' };
}

function passingReviewTime(reviewedAt, asOf = new Date().toISOString()) {
  return typeof reviewedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(reviewedAt) &&
    Number.isFinite(Date.parse(reviewedAt)) && Number.isFinite(Date.parse(asOf)) && Date.parse(reviewedAt) <= Date.parse(asOf);
}
