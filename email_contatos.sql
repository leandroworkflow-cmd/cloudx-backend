-- CloudX — E-mail marketing: contatos importados da lista pessoal (CSV do Google Contatos)
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run
-- (precisa do email_marketing.sql já rodado: a lista de descadastros é compartilhada)

create table if not exists public.email_contatos (
  email      text primary key,
  nome       text,
  origem     text not null default 'csv',
  criado_em  timestamptz not null default now()
);

-- Segurança: RLS ligado e SEM políticas = só o backend (service role) enxerga
alter table public.email_contatos enable row level security;
