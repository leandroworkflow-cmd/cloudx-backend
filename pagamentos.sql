-- CloudX — Histórico de pagamentos (alimenta o card "Receita" do painel)
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run
-- Cada pagamento aprovado no Mercado Pago vira uma linha. O id do pagamento é único:
-- se o Mercado Pago avisar duas vezes sobre o mesmo pagamento, o plano NÃO é renovado em dobro.

create table if not exists public.pagamentos (
  mp_payment_id text primary key,
  user_id       text not null,
  plano         text not null,
  valor         numeric(10,2) not null,
  pago_em       timestamptz not null default now(),
  origem        text not null default 'webhook'      -- 'webhook' (novo) ou 'mercadopago' (importado)
);

create index if not exists pagamentos_pago_em_idx on public.pagamentos (pago_em);
create index if not exists pagamentos_user_idx    on public.pagamentos (user_id);

-- Só o servidor (service role) lê e grava; ninguém pelo navegador.
alter table public.pagamentos enable row level security;
