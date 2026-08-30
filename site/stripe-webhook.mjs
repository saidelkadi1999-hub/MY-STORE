// api/stripe-webhook.mjs  (Vercel Function — converti depuis Netlify)
// Reçoit les événements Stripe. Vérifie la signature (zéro dépendance, crypto natif).
// À "checkout.session.completed" ET payé → crée la commande via la RPC Supabase
// create_paid_order(p_token, p_session, p_pi). Idempotent.
//
// IMPORTANT (Vercel) : le corps BRUT est requis pour vérifier la signature Stripe,
// donc on DÉSACTIVE le body parser et on lit le flux nous-mêmes.

import crypto from 'crypto';

// Désactive le parsing automatique du corps (obligatoire pour la signature Stripe)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_KEY) { res.status(500).send('Config serveur manquante'); return; }

  // Corps BRUT (flux lu manuellement car bodyParser est désactivé)
  const sig = req.headers['stripe-signature'] || req.headers['Stripe-Signature'];
  let raw;
  try { raw = await readRawBody(req); } catch (e) { res.status(400).send('Corps illisible'); return; }

  if (!verifyStripeSignature(raw, sig, WEBHOOK_SECRET)) { res.status(400).send('Signature invalide'); return; }

  let evt;
  try { evt = JSON.parse(raw); } catch (e) { res.status(400).send('JSON invalide'); return; }

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
            // Signature réelle de la fonction : create_paid_order(p_token uuid, p_session text, p_pi text)
            body: JSON.stringify({
              p_token: token,
              p_session: s.id,
              p_pi: s.payment_intent || null
            })
          });
          if (!r.ok) {
            const t = await r.text();
            console.error('create_paid_order a échoué:', r.status, t);
            // 500 → Stripe réessaiera l'événement (utile en cas d'erreur transitoire)
            res.status(500).send('RPC error'); return;
          }
        } catch (e) {
          console.error('Webhook exception:', e.message);
          res.status(500).send('exception'); return;
        }
      } else {
        console.error('Aucun token dans metadata pour la session', s.id);
      }
    }
  }

  // 200 = accusé de réception à Stripe
  res.status(200).json({ received: true });
}

// Lit le corps brut de la requête (flux Node)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Vérification manuelle de la signature Stripe (schéma t=..,v1=..)
function verifyStripeSignature(payload, header, secret) {
  if (!payload || !header) return false;
  const t = (header.split(',').find((p) => p.trim().startsWith('t=')) || '').trim().slice(2);
  const v1list = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  if (!t || !v1list.length) return false;
  const signed = `${t}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  // comparaison à temps constant contre chaque v1 fourni
  return v1list.some((v1) => {
    const a = Buffer.from(v1); const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
