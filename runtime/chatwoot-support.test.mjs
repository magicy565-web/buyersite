import test from 'node:test';
import assert from 'node:assert/strict';
import { getChatwootSupport, handleChatwootSupport } from './chatwoot-support.mjs';
const config = { publication: 'public', origin: 'https://merchant.example', siteSlug: 'merchant-one' };
const env = {
  BUYERSITE_CHATWOOT_ENABLED: 'true',
  BUYERSITE_CHATWOOT_MERCHANT_AUTHORIZED: 'true',
  BUYERSITE_CHATWOOT_SITE_SLUG: 'merchant-one',
  BUYERSITE_CHATWOOT_SITE_ORIGIN: 'https://merchant.example',
  BUYERSITE_CHATWOOT_BASE_URL: 'https://support.example',
  BUYERSITE_CHATWOOT_WEBSITE_TOKEN: 'public_widget_token',
  BUYERSITE_CHATWOOT_MERCHANT_NAME: 'Example Merchant',
  CHATWOOT_API_TOKEN: 'must-never-expose',
  CHATWOOT_WEBHOOK_SECRET: 'must-never-expose'
};
const request = new Request('https://merchant.example/api/buyer/support/config');
test('only public, explicitly authorized, tenant-bound widget configuration is exposed', () => {
  assert.deepEqual(getChatwootSupport(request, env, config), {
    enabled: true, site_slug: 'merchant-one', base_url: 'https://support.example',
    website_token: 'public_widget_token', merchant_name: 'Example Merchant'
  });
  assert.equal(JSON.stringify(getChatwootSupport(request, env, config)).includes('must-never-expose'), false);
});
test('defaults off, rejects private editions and unapproved merchant representation', () => {
  for (const e of [{}, {...env, BUYERSITE_CHATWOOT_ENABLED:'false'}, {...env, BUYERSITE_CHATWOOT_MERCHANT_AUTHORIZED:'false'}]) {
    assert.deepEqual(getChatwootSupport(request, e, config), {enabled:false});
  }
  assert.deepEqual(getChatwootSupport(request, env, {...config, publication:'private'}), {enabled:false});
});
test('rejects cross-tenant and noncanonical requests', () => {
  assert.deepEqual(getChatwootSupport(request, env, {...config, siteSlug:'merchant-two'}), {enabled:false});
  assert.deepEqual(getChatwootSupport(new Request('https://other.example/api/buyer/support/config'), env, config), {enabled:false});
  assert.deepEqual(getChatwootSupport(request, {...env, BUYERSITE_CHATWOOT_SITE_ORIGIN:'https://other.example'}, config), {enabled:false});
});
test('rejects invalid widget origins and token', () => {
  for (const url of ['http://support.example','https://name:pass@support.example','https://support.example/other','https://support.example/?x=1','javascript:alert(1)']) {
    assert.deepEqual(getChatwootSupport(request, {...env, BUYERSITE_CHATWOOT_BASE_URL:url}, config), {enabled:false});
  }
  assert.deepEqual(getChatwootSupport(request, {...env, BUYERSITE_CHATWOOT_WEBSITE_TOKEN:'<script>'}, config), {enabled:false});
});
test('configuration is GET-only and never cached', async () => {
  const response = handleChatwootSupport(request, env, config);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal((await response.json()).enabled,true);
  const rejected = handleChatwootSupport(new Request(request.url,{method:'POST'}),env,config);
  assert.equal(rejected.status,405);
  assert.equal(rejected.headers.get('Allow'),'GET');
});
