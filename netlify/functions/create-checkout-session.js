// netlify/functions/create-checkout-session.js
// Crée une session Stripe Checkout. Zéro dépendance (fetch natif Node 18).
// Sécurité : les prix sont TOUJOURS recalculés côté serveur depuis Supabase,
// jamais lus depuis le client.

const FREE_SHIP = 49;      // livraison offerte dès 49 €
const FLAT_SHIP = 4.90;    // sinon frais de port

exports.handler = async function (event) {
  // CORS / préflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = (process.env.SITE_URL || siteFrom(event)).replace(/\/$/, '');

  if (!STRIPE_SECRET_KEY) return json(500, { error: 'Config manquante : STRIPE_SECRET_KEY' });
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Config manquante : Supabase' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'JSON invalide' });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const customer = body.customer || {};
  if (!items.length) return json(400, { error: 'Panier vide' });

  // 1) Récupère les produits authentiques depuis Supabase
  const ids = [...new Set(items.map(function (i) { return i.id; }).filter(function (v) { return v != null; }))];
  if (!ids.length) return json(400, { error: 'Aucun article valide' });

  let products;
  const q_url = SUPABASE_URL + '/rest/v1/products?select=legacy_id,name,price&legacy_id=in.(' + ids.join(',') + ')';
  try {
    const r = await fetch(q_url, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    const bodyText = await r.text();
    if (!r.ok) {
      console.error('[products-read] HTTP', r.status, '| url:', q_url, '| body:', bodyText);
      return json(502, { error: 'Lecture produits impossible', supabase_status: r.status, supabase_detail: bodyText.slice(0, 400), ids_recherches: ids });
    }
    products = JSON.parse(bodyText);
    console.log('[products-read] OK', r.status, '| trouvés:', products.length, '/', ids.length, '| ids:', ids.join(','));
  } catch (e) {
    console.error('[products-read] EXCEPTION', String(e), '| url:', q_url);
    return json(502, { error: 'Lecture produits impossible', exception: String(e).slice(0, 300) });
  }
  if (!products.length) {
    console.error('[products-read] AUCUN produit | ids:', ids.join(','), '| (legacy_id non rempli ou table vide ?)');
    return json(400, { error: 'Aucun produit trouvé pour ces ids (legacy_id manquant ?)', ids_recherches: ids });
  }

  const byId = {};
  products.forEach(function (p) { byId[p.legacy_id] = p; });

  // 2) Construit les lignes Stripe avec les PRIX SERVEUR
  const line_items = [];
  let subtotal = 0;
  for (const it of items) {
    const p = byId[it.id];
    if (!p) return json(400, { error: 'Produit introuvable : ' + it.id });
    const qty = Math.max(1, parseInt(it.q || it.qty || 1, 10));
    const price = Number(p.price);
    if (!(price >= 0)) return json(400, { error: 'Prix invalide : ' + it.id });
    subtotal += price * qty;
    const opts = [it.col, it.size].filter(Boolean).join(' · ');
    line_items.push({
      name: p.name + (opts ? ' (' + opts + ')' : ''),
      unit_amount: Math.round(price * 100),
      quantity: qty
    });
  }

  // 3) Frais de port (offerts dès 49 €)
  const shipping = subtotal >= FREE_SHIP ? 0 : FLAT_SHIP;

  // 4) Enregistre le payload → token (commande créée APRÈS paiement via le webhook)
  const token = cryptoRandom();
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/checkout_payloads', {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        token: token,
        payload: { items: items, customer: customer, totals: { subtotal: subtotal, shipping: shipping, total: subtotal + shipping, currency: 'EUR' } }
      })
    });
    const bodyText = await r.text();
    if (!r.ok) {
      console.error('[payload-insert] HTTP', r.status, '| body:', bodyText);
      return json(502, { error: 'Préparation commande impossible', supabase_status: r.status, supabase_detail: bodyText.slice(0, 400) });
    }
    console.log('[payload-insert] OK', r.status, '| token:', token);
  } catch (e) {
    console.error('[payload-insert] EXCEPTION', String(e));
    return json(502, { error: 'Préparation commande impossible', exception: String(e).slice(0, 300) });
  }

  // 5) Crée la session Stripe Checkout (API REST, form-urlencoded)
  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('locale', 'fr');
  form.append('success_url', SITE_URL + '/merci.html?session_id={CHECKOUT_SESSION_ID}');
  form.append('cancel_url', SITE_URL + '/checkout.html');
  form.append('metadata[token]', token);
  form.append('payment_intent_data[metadata][token]', token);
  if (customer.email) form.append('customer_email', customer.email);
  line_items.forEach(function (li, i) {
    form.append('line_items[' + i + '][price_data][currency]', 'eur');
    form.append('line_items[' + i + '][price_data][product_data][name]', li.name);
    form.append('line_items[' + i + '][price_data][unit_amount]', String(li.unit_amount));
    form.append('line_items[' + i + '][quantity]', String(li.quantity));
  });
  if (shipping > 0) {
    const i = line_items.length;
    form.append('line_items[' + i + '][price_data][currency]', 'eur');
    form.append('line_items[' + i + '][price_data][product_data][name]', 'Livraison');
    form.append('line_items[' + i + '][price_data][unit_amount]', String(Math.round(shipping * 100)));
    form.append('line_items[' + i + '][quantity]', '1');
  }

  let session;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    session = await r.json();
    if (!r.ok) {
      throw new Error(session.error && session.error.message ? session.error.message : 'Stripe ' + r.status);
    }
  } catch (e) {
    return json(502, { error: 'Stripe : ' + e.message });
  }

  return json(200, { id: session.id, url: session.url });
};

// ---- helpers ----
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function json(statusCode, obj) {
  return {
    statusCode: statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors()),
    body: JSON.stringify(obj)
  };
}

function siteFrom(event) {
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers.host;
  return proto + '://' + host;
}

function cryptoRandom() {
  // token = UUID valide (la colonne checkout_payloads.token est de type uuid)
  return require('crypto').randomUUID();
}
