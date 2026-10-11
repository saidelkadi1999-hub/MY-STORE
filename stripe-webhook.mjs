// api/stripe-webhook.mjs  (Vercel Function — converti depuis Netlify)
// Reçoit les événements Stripe. Vérifie la signature (zéro dépendance, crypto natif).
// À "checkout.session.completed" ET payé → crée la commande via la RPC Supabase
// create_paid_order(p_token, p_session, p_pi_intent). Idempotent.
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
            // Signature réelle de la fonction : create_paid_order(p_token uuid, p_session text, p_pi_intent text)
            body: JSON.stringify({
              p_token: token,
              p_session: s.id,
              p_pi_intent: s.payment_intent || null
            })
          });
          const rpcText = await r.text();
          console.log('[create_paid_order] session=' + s.id + ' | HTTP ' + r.status + ' | reponse=' + rpcText);

          // (1) HTTP non OK -> echec franc -> 500 pour que Stripe reessaie
          if (!r.ok) {
            console.error('[create_paid_order] ECHEC HTTP | session=' + s.id + ' | http_status=' + r.status + ' | body=' + rpcText);
            res.status(500).send('RPC error'); return;
          }

          // (2) HTTP 200 : la RPC repond 200 MEME quand elle ne cree AUCUNE commande.
          //     On lit donc le CORPS de la reponse pour savoir ce qui s'est reellement passe.
          let rpcJson = null;
          try { rpcJson = JSON.parse(rpcText); } catch (e) { rpcJson = null; }
          const st = rpcJson && rpcJson.status;

          if (st === 'created') {
            // succes reel : la commande existe desormais dans orders
            console.log('[create_paid_order] CREATED | session=' + s.id + ' | order_id=' + rpcJson.order_id);
          } else if (st === 'already') {
            // idempotence : une commande existe deja pour ce stripe_session_id.
            // Aucun doublon n'est cree. On accuse reception (200) pour stopper les relances Stripe.
            console.warn('[create_paid_order] ALREADY (idempotence) | session=' + s.id + ' | order_id=' + (rpcJson ? rpcJson.order_id : '?') + ' | AUCUNE nouvelle commande, AUCUN doublon');
          } else {
            // reponse non reconnue -> on ne suppose PAS un succes -> 500 pour relance Stripe
            console.error('[create_paid_order] REPONSE INATTENDUE | session=' + s.id + ' | http_status=' + r.status + ' | body=' + rpcText);
            res.status(500).send('RPC unexpected response'); return;
          }
        } catch (e) {
          console.error('[create_paid_order] EXCEPTION | session=' + s.id + ' | ' + ((e && e.message) ? e.message : String(e)));
          res.status(500).send('exception'); return;
        }
      } else {
        console.error('[webhook] AUCUN token dans metadata → RPC pas appelee, aucune commande. session=' + s.id);
      }
    } else {
      console.warn('[webhook] session ' + s.id + ' recue mais payment_status=' + s.payment_status + ' (differe de paid) → aucune commande creee');
    }
  } else {
    console.log('[webhook] evenement ignore (type=' + evt.type + ')');
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
