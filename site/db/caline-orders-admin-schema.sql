-- ============================================================================
--  CÂLINE — Gestion des commandes (Phase 4)
--  À exécuter dans Supabase → SQL Editor APRÈS les schémas précédents
-- ============================================================================

-- Champs utiles à l'affichage des commandes -----------------------------------
alter table orders add column if not exists phone          text;
alter table orders add column if not exists payment_method text;   -- 'card','cod','transfer'...

create index if not exists idx_orders_created on orders(created_at desc);

-- L'accès admin (lecture + mise à jour du statut) est déjà couvert par la policy
--   "admin orders" : for all using (is_admin()) with check (is_admin())
-- créée dans caline-admin-schema.sql. Rien d'autre à ajouter.

-- ----------------------------------------------------------------------------
--  (FACULTATIF) Commande de TEST pour voir l'interface fonctionner.
--  À exécuter seulement si vous voulez des données d'essai, puis supprimable.
--  Décommentez le bloc ci-dessous :
-- ----------------------------------------------------------------------------
-- do $$
-- declare oid bigint;
-- begin
--   insert into orders(email,phone,status,payment_method,subtotal,shipping_total,total,
--                      shipping_name,shipping_address,shipping_city,shipping_postal,shipping_country)
--   values ('client@example.com','+33 6 12 34 56 78','paid','card',49.98,0,49.98,
--           'Sophie Martin','12 rue des Lilas','Marseille','13006','France')
--   returning id into oid;
--   insert into order_items(order_id,name,unit_price,quantity,color,size,line_total)
--   values (oid,'Collier Cuir Gravé',16.63,1,'Marron','M',16.63),
--          (oid,'Coussin Ultra Doux pour Chat',29.99,1,'Beige',null,29.99);
-- end $$;
