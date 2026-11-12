-- CloudX — Origem do tráfego (utm_source do link). Rode UMA vez no Supabase.
alter table public.page_views add column if not exists origem text;
