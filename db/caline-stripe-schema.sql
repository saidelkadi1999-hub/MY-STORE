-- ============================================================================
--  CÂLINE — Intégration Stripe (Phase paiement)
--  À exécuter dans Supabase → SQL Editor APRÈS les schémas précédents.
--  Crée : table de transit (payload) + fonction atomique de création de
--  commande PAYÉE (commande + articles + décrément du stock), idempotente.
-- ============================================================================

-- 1) Table de transit : ne contient PAS de commande, juste le panier en attente
create table if not exists checkout_payloads (
  token       uuid primary key default gen_random_uuid(),
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
alter table checkout_payloads enable row level security;
-- Aucune policy publique : seul le service_role (fonctions serveur) y accède.

-- 2) Idempotence : une session Stripe ne peut créer qu'une seule commande
create unique index if not exists uniq_orders_stripe_session
  on orders(stripe_session_id) where stripe_session_id is not null;

-- 3) Création atomique de la commande, APRÈS paiement confirmé uniquement
create or replace function create_paid_order(p_token uuid, p_session text, p_pi text)
returns json language plpgsql security definer set search_path=public as $$
declare
  pl jsonb; o_id bigint; existing bigint; itm jsonb; pid bigint;
begin
  -- déjà traitée ? (webhook rejoué) -> on ne recrée rien
  select id into existing from orders where stripe_session_id = p_session;
  if existing is not null then
    return json_build_object('status','already','order_id',existing);
  end if;

  select payload into pl from checkout_payloads where token = p_token;
  if pl is null then
    raise exception 'payload introuvable pour ce token';
  end if;

  insert into orders(
    email, phone, status, payment_method,
    subtotal, shipping_total, discount_total, total, currency,
    stripe_session_id, stripe_payment_intent,
    shipping_name, shipping_address, shipping_city, shipping_postal, shipping_country, notes
  ) values (
    pl->'customer'->>'email',
    pl->'customer'->>'phone',
    'paid', 'card',
    (pl->'totals'->>'subtotal')::numeric,
    (pl->'totals'->>'shipping')::numeric,
    0,
    (pl->'totals'->>'total')::numeric,
    coalesce(pl->'totals'->>'currency','EUR'),
    p_session, p_pi,
    nullif(trim(coalesce(pl->'customer'->>'firstname','')||' '||coalesce(pl->'customer'->>'lastname','')),''),
    pl->'customer'->>'address',
    pl->'customer'->>'city',
    pl->'customer'->>'postal',
    pl->'customer'->>'country',
    pl->'customer'->>'notes'
  ) returning id into o_id;

  for itm in select * from jsonb_array_elements(pl->'items') loop
    select id into pid from products where legacy_id = (itm->>'id')::int;
    insert into order_items(order_id, product_id, name, unit_price, quantity, color, size, line_total)
    values (
      o_id, pid,
      itm->>'name',
      (itm->>'price')::numeric,
      (itm->>'qty')::int,
      nullif(itm->>'color','null'),
      nullif(itm->>'size','null'),
      (itm->>'price')::numeric * (itm->>'qty')::int
    );
    -- décrément du stock
    if pid is not null then
      update products
        set stock = greatest(coalesce(stock,0) - (itm->>'qty')::int, 0),
            in_stock = (greatest(coalesce(stock,0) - (itm->>'qty')::int, 0) > 0)
        where id = pid;
    end if;
  end loop;

  delete from checkout_payloads where token = p_token;
  return json_build_object('status','created','order_id',o_id);
end $$;

-- Sécurité : exécutable uniquement côté serveur (service_role contourne le RLS).
revoke execute on function create_paid_order(uuid,text,text) from anon, authenticated;
