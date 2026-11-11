-- CloudX — Métricas por região (cidade / estado)
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run
-- Guarda só cidade, UF e país (vindos do IP pela Vercel). O IP em si NÃO é gravado.

alter table public.page_views add column if not exists cidade text;
alter table public.page_views add column if not exists estado text;
alter table public.page_views add column if not exists pais   text;

alter table public.perfis add column if not exists cidade text;
alter table public.perfis add column if not exists estado text;
alter table public.perfis add column if not exists pais   text;
