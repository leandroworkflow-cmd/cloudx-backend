-- CloudX — arquivos de cada cliente (usado no card "Ativação" do painel)
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run
-- Conta os arquivos reais guardados no Storage por cliente (o 1º trecho do caminho é o id do usuário).

create or replace function public.admin_arquivos_por_usuario()
returns table (user_id text, arquivos bigint, bytes bigint, ultimo_envio timestamptz)
language sql
security definer
set search_path = public, storage
as $$
  select split_part(name, '/', 1)                       as user_id,
         count(*)::bigint                                as arquivos,
         coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes,
         max(created_at)                                 as ultimo_envio
  from storage.objects
  where bucket_id = 'arquivos'
    and name like '%/%'
    and name not like '%/.keep'          -- ignora os marcadores de pasta
  group by 1;
$$;

revoke all on function public.admin_arquivos_por_usuario() from public, anon, authenticated;
grant execute on function public.admin_arquivos_por_usuario() to service_role;
