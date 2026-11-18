import { loadBuyerKnowledge } from '../lib/buyer-knowledge';

export function GET() {
  return new Response(JSON.stringify(loadBuyerKnowledge(), null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}
