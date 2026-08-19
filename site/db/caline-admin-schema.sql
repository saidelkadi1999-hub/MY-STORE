-- ============================================================================
--  CÂLINE — Admin & Tableau de bord (Phase 2)
--  À exécuter dans Supabase → SQL Editor APRÈS caline-schema.sql + caline-seed.sql
-- ============================================================================

-- 1) Table des administrateurs ------------------------------------------------
create table if not exists admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);
alter table admins enable row level security;

-- 2) Fonction is_admin()  (security definer = ignore le RLS pour vérifier) -----
create or replace function is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

drop policy if exists "admins read self" on admins;
create policy "admins read self" on admins for select using (is_admin());

-- 3) Table des visites (compteur de visiteurs réel) ---------------------------
create table if not exists visits (
  id          bigint generated always as identity primary key,
  session_id  text,
  path        text,
  referrer    text,
  ua          text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_visits_created on visits(created_at);
create index if not exists idx_visits_session on visits(session_id);
alter table visits enable row level security;

drop policy if exists "insert visit" on visits;
create policy "insert visit" on visits for insert with check (true);     -- tracking public
drop policy if exists "admin read visits" on visits;
create policy "admin read visits" on visits for select using (is_admin());

-- 4) Accès admin aux données sensibles + gestion du catalogue -----------------
drop policy if exists "admin orders"      on orders;
create policy "admin orders"      on orders      for all using (is_admin()) with check (is_admin());
drop policy if exists "admin order_items" on order_items;
create policy "admin order_items" on order_items for all using (is_admin()) with check (is_admin());
drop policy if exists "admin customers"   on customers;
create policy "admin customers"   on customers   for all using (is_admin()) with check (is_admin());
drop policy if exists "admin coupons"     on coupons;
create policy "admin coupons"     on coupons     for all using (is_admin()) with check (is_admin());
drop policy if exists "admin reviews"     on reviews;
create policy "admin reviews"     on reviews     for all using (is_admin()) with check (is_admin());
drop policy if exists "admin products"    on products;
create policy "admin products"    on products    for all using (is_admin()) with check (is_admin());
drop policy if exists "admin categories"  on categories;
create policy "admin categories"  on categories  for all using (is_admin()) with check (is_admin());
drop policy if exists "admin settings"    on settings;
create policy "admin settings"    on settings    for all using (is_admin()) with check (is_admin());

-- ============================================================================
--  5) Fonctions RPC du tableau de bord (sécurisées, données RÉELLES)
--     Revenu = commandes au statut paid / processing / shipped / delivered
-- ============================================================================

create or replace function admin_overview()
returns json language plpgsql security definer set search_path=public as $$
declare res json;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select json_build_object(
    'total_sales',     coalesce((select sum(total) from orders
                                 where status in ('paid','processing','shipped','delivered')),0),
    'orders_count',    (select count(*) from orders),
    'customers_count', (select count(*) from customers),
    'visitors_count',  (select count(distinct session_id) from visits)
  ) into res;
  return res;
end $$;

create or replace function admin_top_products(p_limit int default 6)
returns table(product_id bigint, name text, qty bigint, revenue numeric)
language plpgsql security definer set search_path=public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
    select oi.product_id, coalesce(p.name, oi.name) as name,
           sum(oi.quantity)::bigint as qty, sum(oi.line_total) as revenue
    from order_items oi
    join orders o on o.id = oi.order_id
      and o.status in ('paid','processing','shipped','delivered')
    left join products p on p.id = oi.product_id
    group by oi.product_id, coalesce(p.name, oi.name)
    order by qty desc
    limit p_limit;
end $$;

create or replace function admin_recent_orders(p_limit int default 8)
returns table(order_number text, email text, status order_status, total numeric, created_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
    select o.order_number, o.email, o.status, o.total, o.created_at
    from orders o order by o.created_at desc limit p_limit;
end $$;

create or replace function admin_daily_revenue(p_days int default 14)
returns table(day date, revenue numeric)
language plpgsql security definer set search_path=public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
    select d::date as day,
      coalesce((select sum(total) from orders o
                where o.status in ('paid','processing','shipped','delivered')
                  and o.created_at::date = d::date),0) as revenue
    from generate_series(current_date - (p_days-1), current_date, interval '1 day') d
    order by day;
end $$;

create or replace function admin_monthly_revenue(p_months int default 12)
returns table(month date, revenue numeric)
language plpgsql security definer set search_path=public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
    select m::date as month,
      coalesce((select sum(total) from orders o
                where o.status in ('paid','processing','shipped','delivered')
                  and date_trunc('month',o.created_at) = m),0) as revenue
    from generate_series(date_trunc('month',current_date) - ((p_months-1)||' months')::interval,
                         date_trunc('month',current_date), interval '1 month') m
    order by month;
end $$;

grant execute on function is_admin()                 to anon, authenticated;
grant execute on function admin_overview()           to authenticated;
grant execute on function admin_top_products(int)    to authenticated;
grant execute on function admin_recent_orders(int)   to authenticated;
grant execute on function admin_daily_revenue(int)   to authenticated;
grant execute on function admin_monthly_revenue(int) to authenticated;

-- ============================================================================
--  6) DÉCLARER VOTRE COMPTE ADMIN
--  a) Supabase → Authentication → Users → Add user (email + mot de passe)
--  b) Copiez son "User UID", puis exécutez (en remplaçant la valeur) :
--
--     insert into admins(user_id, email)
--     values ('00000000-0000-0000-0000-000000000000', 'vous@email.com')
--     on conflict (user_id) do nothing;
-- ============================================================================
