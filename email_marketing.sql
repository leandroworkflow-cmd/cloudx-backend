-- CloudX — E-mail marketing: tabelas de campanhas, envios e descadastros
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run

-- Quem pediu para não receber mais e-mails (sempre respeitado)
create table if not exists public.email_descadastros (
  email      text primary key,
  criado_em  timestamptz not null default now()
);

-- Cada disparo feito pelo painel
create table if not exists public.email_campanhas (
  id           bigint generated always as identity primary key,
  assunto      text not null,
  corpo        text not null,
  publico      text not null,
  total        integer not null default 0,
  enviados     integer not null default 0,
  falhas       integer not null default 0,
  status       text not null default 'enviando',   -- enviando | pausada | concluida | cancelada
  criado_em    timestamptz not null default now(),
  concluido_em timestamptz
);

-- Uma linha por destinatário de cada campanha
create table if not exists public.email_envios (
  id           bigint generated always as identity primary key,
  campanha_id  bigint not null references public.email_campanhas(id) on delete cascade,
  email        text not null,
  nome         text,
  status       text not null default 'pendente',   -- pendente | enviando | enviado | falha | descadastrado
  erro         text,
  reservado_em timestamptz,
  enviado_em   timestamptz
);

create index if not exists email_envios_campanha_status on public.email_envios (campanha_id, status);
create index if not exists email_envios_enviado_em on public.email_envios (enviado_em) where status = 'enviado';

-- Segurança: RLS ligado e SEM políticas = só o backend (service role) enxerga esses dados
alter table public.email_descadastros enable row level security;
alter table public.email_campanhas    enable row level security;
alter table public.email_envios       enable row level security;
