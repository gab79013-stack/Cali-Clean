/** Genera leads de ejemplo para ver el panel con datos. node scripts/seed.js [n] */
import { db } from '../src/db.js';
import { calculateQuote } from '../src/services/quote.js';
import { scoreLead, isInServiceArea } from '../src/services/scoring.js';
import { newUid } from '../src/utils/tokens.js';

const N = Number(process.argv[2]) || 25;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const NAMES = ['María López', 'James Carter', 'Ana Ruiz', 'Priya Patel', 'Diego Márquez', 'Sarah Kim', 'Luis Herrera', 'Emily Chen', 'Carlos Vega', 'Rachel Moore'];
const ZIPS = ['90001', '90012', '90028', '90210', '90401', '91201', '99999'];
const SRC = ['google', 'facebook', 'instagram', 'yelp', '', 'nextdoor'];

let inserted = 0;
for (let i = 0; i < N; i++) {
  const segment = Math.random() < 0.32 ? 'commercial' : 'residential';
  const input = segment === 'commercial'
    ? { segment, sqft: pick([1500, 3000, 6000, 12000]), serviceType: pick(['office', 'retail', 'medical', 'restaurant']), frequency: pick(['weekly', 'biweekly', 'monthly', 'daily']) }
    : { segment, bedrooms: pick([1, 2, 3, 4, 5]), bathrooms: pick([1, 2, 3]), serviceType: pick(['standard', 'deep', 'move', 'post_construction']), frequency: pick(['one_time', 'weekly', 'biweekly', 'monthly']), addons: Math.random() < 0.45 ? [pick(['oven', 'fridge', 'windows_interior'])] : [] };

  const quote = calculateQuote(input);
  const name = pick(NAMES);
  const zip = pick(ZIPS);
  const lead = {
    uid: newUid(), name, email: `${name.split(' ')[0].toLowerCase()}${i}@example.com`,
    phone: Math.random() < 0.7 ? `+1310555${String(1000 + i).slice(-4)}` : '',
    zip, address: '', locale: Math.random() < 0.4 ? 'es' : 'en',
    segment: quote.segment, service_type: quote.serviceType, frequency: quote.frequency,
    bedrooms: input.bedrooms || null, bathrooms: input.bathrooms || null, sqft: input.sqft || null,
    addons: JSON.stringify(quote.addons), preferred_date: '', message: '',
    quote_price: quote.price, quote_low: quote.low, quote_high: quote.high,
    annual_value: quote.annualValue, quote_json: JSON.stringify(quote),
    source: 'seed', landing_page: 'https://cali-clean.net/', referrer: '',
    utm_source: pick(SRC), utm_medium: pick(['cpc', 'organic', '']), utm_campaign: pick(['spring', 'brand', '']),
    utm_term: '', utm_content: '', gclid: '', fbclid: '', ip: '127.0.0.1', user_agent: 'seed',
    in_service_area: isInServiceArea(zip) ? 1 : 0,
    status: pick(['new', 'new', 'new', 'engaged', 'contacted', 'booked', 'won', 'lost']),
  };
  const s = scoreLead(lead, quote);
  Object.assign(lead, { score: s.score, temperature: s.temperature, score_reasons: JSON.stringify(s.reasons) });

  const cols = Object.keys(lead);
  db.prepare(`INSERT INTO leads (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(lead);
  inserted++;
}
console.log(`✓ ${inserted} leads de ejemplo insertados.`);
