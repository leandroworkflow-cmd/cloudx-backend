-- CloudX — conta os arquivos armazenados (usado pelo dashboard executivo)
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run

create or replace function public.admin_contar_arquivos()
returns bigint
language sql
security definer
set search_path = public, storage
as $$
  select count(*)::bigint
  from storage.objects
  where bucket_id = 'arquivos'
    and name not like '%/.keep';   -- ignora os marcadores de pasta
$$;

revoke all on function public.admin_contar_arquivos() from public, anon, authenticated;
grant execute on function public.admin_contar_arquivos() to service_role;
