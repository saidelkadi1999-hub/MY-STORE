// netlify/functions/stripe-webhook.js
// Reçoit les événements Stripe. Vérifie la signature (zéro dépendance, crypto natif).
// À "checkout.session.completed" ET payé → crée la commande en base via la RPC
// Supabase create_paid_order(token, session, payment_intent). Idempotent.

const crypto = require('crypto');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: 'Config serveur manquante' };
  }

  // Corps brut requis pour vérifier la signature
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  if (!verifyStripeSignature(raw, sig, WEBHOOK_SECRET)) {
    return { statusCode: 400, body: 'Signature invalide' };
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return { statusCode: 400, body: 'JSON invalide' }; }

  // On ne traite que la finalisation d'un paiement réussi
  if (evt.type === 'checkout.session.completed') {
    const s = evt.data.object;
    if (s.payment_status === 'paid') {
      const token = (s.metadata && s.metadata.token) || null;
      if (token) {
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_paid_order`, {
            method: 'POST',
            headers: {
              apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              p_token: token,
              p_session: s.id,
              p_pi_intent: s.payment_intent || null
            })
          });
          if (!r.ok) {
            const t = await r.text();
            console.error('create_paid_order a échoué:', r.status, t);
            // 500 → Stripe réessaiera l'événement (utile en cas d'erreur transitoire)
            return { statusCode: 500, body: 'RPC error' };
          }
        } catch (e) {
          console.error('Webhook exception:', e.message);
          return { statusCode: 500, body: 'exception' };
        }
      } else {
        console.error('Aucun token dans metadata pour la session', s.id);
      }
    }
  }

  // 200 = accusé de réception à Stripe
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// Vérification manuelle de la signature Stripe (schéma t=..,v1=..)
function verifyStripeSignature(payload, header, secret) {
  if (!payload || !header) return false;
  const parts = {};
  header.split(',').forEach(kv => {
    const [k, v] = kv.split('=');
    if (k && v) (parts[k] = parts[k] || []).push ? parts[k].push(v) : (parts[k] = v);
  });
  const t = parts['t'];
  const v1list = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !v1list.length) return false;
  const signed = `${t}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  // comparaison à temps constant contre chaque v1 fourni
  return v1list.some(v1 => {
    const a = Buffer.from(v1); const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
