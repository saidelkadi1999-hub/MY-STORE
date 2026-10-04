/* ============================================================
   CÂLINE — Configuration Supabase (FICHIER UNIQUE PARTAGÉ)

   👉 Renseignez vos 2 identifiants ICI, une seule fois.
      Toutes les pages (magasin + administration) lisent ce fichier.

   Où les trouver :
      Supabase → votre projet → Project Settings (⚙️) → API
        • Project URL      → champ "url"
        • anon public key  → champ "anonKey"

   ⚠️ N'utilisez JAMAIS la clé "service_role" ici (elle est secrète).
   ============================================================ */
window.CALINE_SUPABASE = {
  url:     "https://obxrzznzqzhxwywlqsms.supabase.co",
  anonKey: "sb_publishable_iI7rTyY9Gd6DubxDl2GrNw__INAkUh5"
};

/* ============================================================
   Stripe — clé PUBLIABLE uniquement (sécurisée pour le navigateur).
   À récupérer dans : Stripe → Développeurs → Clés API → "Clé publiable".
   Elle commence par pk_live_... (ou pk_test_... en mode test).
   ⚠️ La clé SECRÈTE (sk_...) ne se met JAMAIS ici — uniquement dans
      les variables d'environnement Netlify.
   ============================================================ */
window.CALINE_STRIPE = {
  publishableKey: ""   // ← collez ici votre clé publiable Stripe (pk_...)
};
