-- CloudX — E-mail marketing: guarda os anexos de cada campanha enquanto ela é enviada
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run
-- (os anexos são apagados sozinhos quando a campanha termina ou é cancelada)

create table if not exists public.email_anexos (
  id           bigint generated always as identity primary key,
  campanha_id  bigint not null references public.email_campanhas(id) on delete cascade,
  nome         text not null,
  tipo         text not null,
  tamanho      integer not null,
  dados        text not null,            -- arquivo em base64
  criado_em    timestamptz not null default now()
);

create index if not exists email_anexos_campanha on public.email_anexos (campanha_id);

-- Segurança: RLS ligado e SEM políticas = só o backend (service role) enxerga
alter table public.email_anexos enable row level security;
