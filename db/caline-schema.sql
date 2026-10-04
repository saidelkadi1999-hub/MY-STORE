-- ============================================================================
--  CÂLINE — Schéma de base de données (Supabase / PostgreSQL)
--  Phase 1 : structure complète + relations + sécurité (RLS)
--  À exécuter dans :  Supabase → SQL Editor → New query → Run
-- ============================================================================

-- Extensions ----------------------------------------------------------------
create extension if not exists pgcrypto;

-- Types -----------------------------------------------------------------------
do $$ begin
  create type order_status as enum
    ('pending','paid','processing','shipped','delivered','cancelled','refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type coupon_type as enum ('percent','fixed','free_shipping');
exception when duplicate_object then null; end $$;

-- Fonction utilitaire : updated_at --------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ============================================================================
--  1) CATEGORIES   (univers chien/chat + sous-catégories = les "chips")
-- ============================================================================
create table if not exists categories (
  id          bigint generated always as identity primary key,
  universe    text    not null check (universe in ('chien','chat')),
  slug        text    not null,
  name        text    not null,
  sort_order  int     not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (universe, slug)
);

-- ============================================================================
--  2) PRODUCTS
-- ============================================================================
create table if not exists products (
  id              bigint generated always as identity primary key,
  legacy_id       int unique,                 -- correspond aux id du front actuel
  slug            text unique,
  name            text not null,
  subtitle        text,
  description     text,
  price           numeric(10,2) not null check (price >= 0),
  old_price       numeric(10,2) check (old_price >= 0),
  shipping        numeric(10,2) default 0,    -- 0/null = offerte (selon seuil réglages)
  category_id     bigint references categories(id) on delete set null,
  rating          numeric(2,1) default 5 check (rating between 0 and 5),
  is_best         boolean not null default false,
  is_new          boolean not null default false,
  is_promo        boolean not null default false,
  is_wellness     boolean not null default false,
  in_stock        boolean not null default true,
  stock           int default 0,
  colors          jsonb not null default '[]'::jsonb,   -- ["Gris","Marron",...]
  color_images    jsonb not null default '{}'::jsonb,   -- {"Gris":5,...} (index dans images)
  sizes           jsonb not null default '[]'::jsonb,
  size_guide      jsonb not null default '[]'::jsonb,   -- [["XS","32 cm","18–27 cm"],...]
  size_guide_head jsonb not null default '[]'::jsonb,   -- ["Taille","Longueur","Tour de cou"]
  pros            jsonb not null default '[]'::jsonb,
  benefits        jsonb not null default '[]'::jsonb,
  faq             jsonb not null default '[]'::jsonb,    -- [["Q","R"],...]
  images          jsonb not null default '[]'::jsonb,    -- ["images/img78.jpg",...]
  video           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_products_category on products(category_id);
create index if not exists idx_products_best on products(is_best) where is_best;
create index if not exists idx_products_new  on products(is_new)  where is_new;
create index if not exists idx_products_promo on products(is_promo) where is_promo;
create index if not exists idx_products_well on products(is_wellness) where is_wellness;

drop trigger if exists trg_products_updated on products;
create trigger trg_products_updated before update on products
  for each row execute function set_updated_at();

-- ============================================================================
--  3) CUSTOMERS   (liés en option à l'authentification Supabase)
-- ============================================================================
create table if not exists customers (
  id               bigint generated always as identity primary key,
  auth_user_id     uuid unique references auth.users(id) on delete set null,
  email            text not null unique,
  full_name        text,
  phone            text,
  address_line     text,
  city             text,
  postal_code      text,
  country          text default 'France',
  marketing_opt_in boolean default false,
  created_at       timestamptz not null default now()
);

-- ============================================================================
--  4) COUPONS
-- ============================================================================
create table if not exists coupons (
  id            bigint generated always as identity primary key,
  code          text not null unique,
  type          coupon_type not null default 'percent',
  value         numeric(10,2) not null default 0,   -- % (0-100) ou montant €
  min_subtotal  numeric(10,2) default 0,
  starts_at     timestamptz,
  expires_at    timestamptz,
  max_uses      int,
  used_count    int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ============================================================================
--  5) ORDERS
-- ============================================================================
create table if not exists orders (
  id               bigint generated always as identity primary key,
  order_number     text not null unique
                   default ('CAL-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(md5(random()::text),1,6))),
  customer_id      bigint references customers(id) on delete set null,
  email            text not null,
  status           order_status not null default 'pending',
  subtotal         numeric(10,2) not null default 0,
  shipping_total   numeric(10,2) not null default 0,
  discount_total   numeric(10,2) not null default 0,
  total            numeric(10,2) not null default 0,
  currency         text not null default 'EUR',
  coupon_id        bigint references coupons(id) on delete set null,
  coupon_code      text,
  stripe_session_id     text,
  stripe_payment_intent text,
  shipping_name    text,
  shipping_address text,
  shipping_city    text,
  shipping_postal  text,
  shipping_country text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_orders_customer on orders(customer_id);
create index if not exists idx_orders_status on orders(status);

drop trigger if exists trg_orders_updated on orders;
create trigger trg_orders_updated before update on orders
  for each row execute function set_updated_at();

-- ============================================================================
--  6) ORDER ITEMS
-- ============================================================================
create table if not exists order_items (
  id          bigint generated always as identity primary key,
  order_id    bigint not null references orders(id) on delete cascade,
  product_id  bigint references products(id) on delete set null,
  name        text not null,            -- copie figée au moment de la commande
  unit_price  numeric(10,2) not null,
  quantity    int not null check (quantity > 0),
  color       text,
  size        text,
  line_total  numeric(10,2) not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_order_items_order on order_items(order_id);
create index if not exists idx_order_items_product on order_items(product_id);

-- ============================================================================
--  7) REVIEWS
-- ============================================================================
create table if not exists reviews (
  id           bigint generated always as identity primary key,
  product_id   bigint not null references products(id) on delete cascade,
  customer_id  bigint references customers(id) on delete set null,
  author_name  text,
  rating       int not null check (rating between 1 and 5),
  title        text,
  body         text,
  is_approved  boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_reviews_product on reviews(product_id);
create index if not exists idx_reviews_approved on reviews(is_approved) where is_approved;

-- ============================================================================
--  8) SETTINGS   (clé / valeur — réglages du magasin)
-- ============================================================================
create table if not exists settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_settings_updated on settings;
create trigger trg_settings_updated before update on settings
  for each row execute function set_updated_at();

-- Vue pratique : note moyenne + nb d'avis par produit -------------------------
create or replace view product_ratings as
  select p.id as product_id,
         coalesce(round(avg(r.rating)::numeric,1),0) as avg_rating,
         count(r.id) filter (where r.is_approved) as reviews_count
  from products p
  left join reviews r on r.product_id = p.id and r.is_approved
  group by p.id;

-- ============================================================================
--  SÉCURITÉ — Row Level Security (RLS)
--  Lecture publique du catalogue ; écritures sensibles réservées au back-office
--  (clé service_role, utilisée plus tard par les fonctions Netlify/Stripe).
-- ============================================================================
alter table categories  enable row level security;
alter table products    enable row level security;
alter table reviews     enable row level security;
alter table settings    enable row level security;
alter table coupons     enable row level security;
alter table customers   enable row level security;
alter table orders      enable row level security;
alter table order_items enable row level security;

-- Lecture publique (clé anon)
drop policy if exists "read categories" on categories;
create policy "read categories" on categories for select using (is_active);

drop policy if exists "read products" on products;
create policy "read products" on products for select using (true);

drop policy if exists "read approved reviews" on reviews;
create policy "read approved reviews" on reviews for select using (is_approved);

drop policy if exists "read settings" on settings;
create policy "read settings" on settings for select using (true);

-- Un visiteur peut soumettre un avis (en attente de modération)
drop policy if exists "insert pending review" on reviews;
create policy "insert pending review" on reviews
  for insert with check (is_approved = false);

-- coupons / customers / orders / order_items : AUCUNE policy anon.
-- => verrouillés. La création de commande passera par une fonction serveur
--    (service_role) à l'étape Stripe. RLS bloque tout accès public en attendant.

-- ============================================================================
--  RÉGLAGES PAR DÉFAUT
-- ============================================================================
insert into settings(key,value) values
 ('store',     '{"name":"CÂLINE","email":"contact@caline.fr","currency":"EUR","locale":"fr-FR"}'::jsonb),
 ('shipping',  '{"flat_rate":4.90,"free_threshold":49}'::jsonb),
 ('analytics', '{"ga4_id":""}'::jsonb),
 ('payment',   '{"stripe_enabled":false}'::jsonb)
on conflict (key) do nothing;

-- Fin du schéma --------------------------------------------------------------
