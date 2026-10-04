-- ============================================================================
--  CÂLINE — Gestion des produits (Phase 3)
--  À exécuter dans Supabase → SQL Editor APRÈS les schémas précédents
-- ============================================================================

-- 1) Visibilité du produit (afficher / masquer sur la boutique) ----------------
alter table products add column if not exists is_visible boolean not null default true;
create index if not exists idx_products_visible on products(is_visible) where is_visible;

-- La lecture publique ne montre que les produits visibles -----------------------
drop policy if exists "read products" on products;
create policy "read products" on products for select using (is_visible);
-- (les admins voient tout via la policy "admin products" for all using(is_admin()))

-- 2) Stockage des images produits (bucket public) ------------------------------
insert into storage.buckets (id, name, public)
values ('product-images','product-images', true)
on conflict (id) do nothing;

-- Lecture publique des images
drop policy if exists "public read product images" on storage.objects;
create policy "public read product images" on storage.objects
  for select using (bucket_id = 'product-images');

-- Écriture réservée aux admins
drop policy if exists "admin upload product images" on storage.objects;
create policy "admin upload product images" on storage.objects
  for insert with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admin update product images" on storage.objects;
create policy "admin update product images" on storage.objects
  for update using (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admin delete product images" on storage.objects;
create policy "admin delete product images" on storage.objects
  for delete using (bucket_id = 'product-images' and public.is_admin());

-- Fin -------------------------------------------------------------------------
