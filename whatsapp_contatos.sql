-- CloudX — WhatsApp: lista de contatos para envio manual (botão "Abrir no WhatsApp")
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run

create table if not exists public.whatsapp_contatos (
  telefone   text primary key,                 -- só dígitos, com DDI (ex.: 5531999999999)
  nome       text,
  status     text not null default 'novo',     -- novo | enviado | nao_enviar
  enviado_em timestamptz,
  criado_em  timestamptz not null default now()
);

create index if not exists whatsapp_contatos_status on public.whatsapp_contatos (status, criado_em);

-- Segurança: RLS ligado e SEM políticas = só o backend (service role) enxerga
alter table public.whatsapp_contatos enable row level security;
