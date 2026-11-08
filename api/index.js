const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');
const mp      = require('../mercadopago');

const app = express();

app.use(cors({ origin: '*' }));
// Corpo maior só nas rotas de e-mail que recebem anexo (a Vercel aceita no máximo 4,5 MB por requisição)
const jsonPadrao = express.json();
const jsonGrande = express.json({ limit: '5mb' });
app.use((req, res, next) => (req.path === '/api/admin/email/preparar' || req.path === '/api/admin/email/teste' ? jsonGrande : jsonPadrao)(req, res, next));

const getDB = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── PLANOS E LIMITES (em bytes) ──
const PLANOS = {
  free:           1   * 1024 * 1024 * 1024,   // 1 GB (padrão, após expirar a promo)
  free_fundador:  2   * 1024 * 1024 * 1024,   // 2 GB — promo "Experimente", válida por 6 meses, sem limite de vagas
  free_campanha:  20  * 1024 * 1024 * 1024,   // 20 GB — CAMPANHA por tempo limitado (72h), válida por 6 meses
  basico:         30  * 1024 * 1024 * 1024,   // 30 GB
  essencial:      100 * 1024 * 1024 * 1024,   // 100 GB
  plus:           300 * 1024 * 1024 * 1024,   // 300 GB
  premium:        1024 * 1024 * 1024 * 1024,  // 1 TB
};

// ── CAMPANHA 20 GB / 72h ──
// Defina PROMO_CAMPANHA_FIM (ISO 8601, ex.: 2026-10-01T23:59:59-03:00) nas variáveis de ambiente
// para controlar o fim da campanha sem mexer no código. Ex.: hora da publicação + 72h.
const CAMPANHA_FIM = new Date(process.env.PROMO_CAMPANHA_FIM || '2026-10-01T23:59:59-03:00');
const campanhaAtiva = () => Date.now() < CAMPANHA_FIM.getTime();

// Público: o front usa para montar o contador (usa a hora do servidor, não a do aparelho)
app.get('/api/promo/campanha', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ativa: campanhaAtiva(),
    fim: CAMPANHA_FIM.toISOString(),
    agora: new Date().toISOString(),
    gb: campanhaAtiva() ? 20 : 2,
  });
});

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Sem token' });
  const db = getDB();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ erro: 'Token inválido' });
  req.user = data.user;
  req.db = db;
  next();
}

// ── Aplica/expira a promoção "free_fundador" antes de devolver o perfil ──
async function resolverPlanoAtual(db, perfil) {
  // Se a promo expirou, rebaixa pra free padrão
  if (['free_fundador', 'free_campanha'].includes(perfil.plano) && perfil.plano_expira_em && new Date(perfil.plano_expira_em) < new Date()) {
    await db.from('perfis').update({ plano: 'free', plano_expira_em: null }).eq('id', perfil.id);
    perfil.plano = 'free';
    perfil.plano_expira_em = null;
  }
  return perfil;
}

app.get('/api/perfil', auth, async (req, res) => {
  const { data, error } = await req.db.from('perfis').select('*').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ erro: error.message });
  const perfil = await resolverPlanoAtual(req.db, data);
  const limite = PLANOS[perfil.plano] || PLANOS.free;
  res.json({ ...perfil, limite, percentual: Math.round((perfil.storage_usado / limite) * 100) });
});

// ── Chamado uma vez no cadastro (signup) para aplicar a promo "Experimente" (2GB/6 meses, sem limite de vagas) ──
app.post('/api/promo/fundador', auth, async (req, res) => {
  const { data: perfil } = await req.db.from('perfis').select('id, plano').eq('id', req.user.id).single();
  if (!perfil) return res.status(404).json({ erro: 'Perfil não encontrado' });

  // Já tem algum plano definido (não é o primeiro contato) — não reaplica
  if (perfil.plano && perfil.plano !== 'free') {
    return res.json({ aplicado: false, motivo: 'Perfil já possui um plano' });
  }

  // Durante a campanha: 20 GB. Depois que acabar: volta ao "Experimente" de 2 GB.
  const plano = campanhaAtiva() ? 'free_campanha' : 'free_fundador';
  const expira = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000).toISOString(); // 6 meses
  const { error } = await req.db.from('perfis').update({
    plano,
    plano_expira_em: expira,
  }).eq('id', req.user.id);

  if (error) return res.status(500).json({ erro: error.message });
  res.json({ aplicado: true, plano, limite: PLANOS[plano], expira_em: expira });
});

app.get('/api/arquivos', auth, async (req, res) => {
  const pasta = req.query.pasta || '';
  const caminho = `${req.user.id}${pasta ? '/' + pasta : ''}`;
  const { data, error } = await req.db.storage.from('arquivos').list(caminho, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// ── Passo 1: gera uma URL assinada pro navegador subir o arquivo DIRETO pro Supabase Storage ──
// (o arquivo nunca passa pela função serverless, então não bate no limite de 4.5MB do Vercel)
app.post('/api/arquivos/upload-url', auth, async (req, res) => {
  const { nome, tamanho, pasta } = req.body || {};
  if (!nome || !tamanho) return res.status(400).json({ erro: 'Nome e tamanho do arquivo são obrigatórios' });

  // Verifica cota antes de autorizar o upload
  const { data: perfil } = await req.db.from('perfis').select('plano, storage_usado, plano_expira_em, id').eq('id', req.user.id).single();
  if (perfil) {
    const perfilAtualizado = await resolverPlanoAtual(req.db, perfil);
    const limite = PLANOS[perfilAtualizado.plano] || PLANOS.free;
    if (perfilAtualizado.storage_usado + Number(tamanho) > limite) {
      return res.status(403).json({ erro: 'Cota excedida', plano: perfilAtualizado.plano });
    }
  }

  const caminho = `${req.user.id}${pasta ? '/' + pasta : ''}/${nome}`;
  const { data, error } = await req.db.storage.from('arquivos').createSignedUploadUrl(caminho, { upsert: true });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ signedUrl: data.signedUrl, token: data.token, caminho });
});

// ── Passo 2: chamado pelo navegador após o upload direto ter concluído, só pra atualizar a cota usada ──
app.post('/api/arquivos/confirmar-upload', auth, async (req, res) => {
  const { caminho, tamanho } = req.body || {};
  if (!caminho || !tamanho) return res.status(400).json({ erro: 'Caminho e tamanho são obrigatórios' });
  if (!caminho.startsWith(req.user.id)) return res.status(403).json({ erro: 'Acesso negado' });
  await req.db.rpc('incrementar_storage', { uid: req.user.id, bytes: Number(tamanho) });
  res.json({ ok: true, caminho, tamanho: Number(tamanho) });
});

app.get('/api/arquivos/download', auth, async (req, res) => {
  const { caminho } = req.query;
  if (!caminho) return res.status(400).json({ erro: 'Caminho obrigatório' });
  if (!caminho.startsWith(req.user.id)) return res.status(403).json({ erro: 'Acesso negado' });
  const { data, error } = await req.db.storage.from('arquivos').createSignedUrl(caminho, 3600);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ url: data.signedUrl });
});

app.delete('/api/arquivos', auth, async (req, res) => {
  const { caminho } = req.body;
  if (!caminho) return res.status(400).json({ erro: 'Caminho obrigatório' });
  if (!caminho.startsWith(req.user.id)) return res.status(403).json({ erro: 'Acesso negado' });
  const { error } = await req.db.storage.from('arquivos').remove([caminho]);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

app.post('/api/pastas', auth, async (req, res) => {
  const { nome, pasta_pai } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const caminho = `${req.user.id}/${pasta_pai ? pasta_pai + '/' : ''}${nome}/.keep`;
  const { error } = await req.db.storage.from('arquivos').upload(caminho, Buffer.from(''), { contentType: 'text/plain', upsert: true });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

app.post('/api/pagamento/criar', auth, async (req, res) => {
  const { plano } = req.body;
  const PRECOS = {
    basico:    { valor: 4.99,  nome: 'Plano Básico — 30 GB'    },
    essencial: { valor: 9.99,  nome: 'Plano Essencial — 100 GB' },
    plus:      { valor: 29.99, nome: 'Plano Plus — 300 GB'     },
    premium:   { valor: 49.99, nome: 'Plano Premium — 1 TB'    },
  };
  if (!PRECOS[plano]) return res.status(400).json({ erro: 'Plano inválido' });
  try {
    const preference = await mp.criarPreferencia({
      items: [{ title: PRECOS[plano].nome, unit_price: PRECOS[plano].valor, quantity: 1, currency_id: 'BRL' }],
      payer: { email: req.user.email },
      external_reference: `${req.user.id}|${plano}`,
      back_urls: {
        success: `${process.env.FRONTEND_URL}/sucesso`,
        failure: `${process.env.FRONTEND_URL}/erro`,
        pending: `${process.env.FRONTEND_URL}/pendente`,
      },
      auto_return: 'approved',
      notification_url: `${process.env.BACKEND_URL}/api/webhook/mp`,
    });
    res.json({ url: preference.init_point });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/webhook/mp', async (req, res) => {
  const { type, data } = req.body;
  if (type !== 'payment') return res.sendStatus(200);
  try {
    const db = getDB();
    const pagamento = await mp.buscarPagamento(data.id);
    if (pagamento.status !== 'approved') return res.sendStatus(200);
    const [userId, plano] = (pagamento.external_reference || '').split('|');
    if (!userId || !plano) return res.sendStatus(200);
    // Busca plano atual para calcular renovação
    const { data: perfilAtual } = await db.from('perfis').select('plano_expira_em').eq('id', userId).single();

    // Se já tem plano ativo, renova a partir da data de expiração
    // Se não, começa agora (30 dias)
    let novaExpiracao;
    if(perfilAtual?.plano_expira_em && new Date(perfilAtual.plano_expira_em) > new Date()) {
      novaExpiracao = new Date(new Date(perfilAtual.plano_expira_em).getTime() + 30 * 24 * 60 * 60 * 1000);
    } else {
      novaExpiracao = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    }

    await db.from('perfis').update({
      plano,
      plano_expira_em: novaExpiracao.toISOString(),
      ultimo_pagamento_id: String(data.id),
    }).eq('id', userId);

    console.log(`✅ Plano ${plano} renovado até ${novaExpiracao.toLocaleDateString('pt-BR')} para ${userId}`);
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(500);
  }
});

const path = require("path");
const root = path.join(__dirname, "..");

app.get("/", (req, res) => { res.sendFile(path.join(root, "index.html")); });
app.get("/manifest.json", (req, res) => { res.sendFile(path.join(root, "manifest.json")); });
app.get("/sw.js", (req, res) => { res.setHeader("Content-Type","application/javascript"); res.sendFile(path.join(root, "sw.js")); });
app.get("/icon.svg", (req, res) => { res.sendFile(path.join(root, "icon.svg")); });
app.get("/favicon.ico", (req, res) => { res.sendFile(path.join(root, "favicon.ico")); });
app.get("/icon-192.png", (req, res) => { res.sendFile(path.join(root, "icon-192.png")); });
app.get("/icon-512.png", (req, res) => { res.sendFile(path.join(root, "icon-512.png")); });
app.get("/sucesso", (req, res) => { res.sendFile(path.join(root, "sucesso.html")); });
app.get("/sucesso", (req, res) => { res.sendFile(require("path").join(__dirname, "../sucesso.html")); });
app.get("/erro", (req, res) => { res.send('<html><body style="font-family:sans-serif;text-align:center;padding:80px"><h1>❌ Pagamento não concluído</h1><p>Tente novamente.</p><a href="/">← Voltar</a></body></html>'); });
app.get("/pendente", (req, res) => { res.send('<html><body style="font-family:sans-serif;text-align:center;padding:80px"><h1>⏳ Pagamento pendente</h1><p>Aguardando confirmação. Seu plano será ativado em breve.</p><a href="/">← Voltar</a></body></html>'); });

module.exports = app;


// ============================================
// ROTAS DE LEADS / CRM
// ============================================

// Lista todos os leads (usado pelo dashboard admin)
app.get('/api/leads', async (req, res) => {
  const db = getDB();
  const { data, error } = await db.from('leads').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// Cria um novo lead (pode ser usado por um formulario de contato no site, futuramente)
app.post('/api/leads', async (req, res) => {
  const { nome, email, telefone, origem, mensagem, plano_recomendado } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatorio' });
  const db = getDB();
  const { data, error } = await db.from('leads').insert({
    nome, email, telefone,
    origem: origem || 'organico',
    mensagem,
    plano_recomendado,
    status: 'novo',
    score: 0,
  }).select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true, lead: data });
});

// Atualiza status/score/plano de um lead (usado no CRM interno)
app.patch('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const { status, score, plano_recomendado, mensagem } = req.body;
  const db = getDB();
  const campos = {};
  if (status !== undefined) campos.status = status;
  if (score !== undefined) campos.score = score;
  if (plano_recomendado !== undefined) campos.plano_recomendado = plano_recomendado;
  if (mensagem !== undefined) campos.mensagem = mensagem;

  const { data, error } = await db.from('leads').update(campos).eq('id', id).select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true, lead: data });
});

// Remove um lead
app.delete('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const db = getDB();
  const { error } = await db.from('leads').delete().eq('id', id);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

// ============================================
// SUBSTITUI a rota /dashboard/stats anterior
// (agora inclui numeros de Leads/CRM tambem)
// ============================================

app.get('/dashboard/stats', async (req, res) => {
  try {
    const db = getDB();

    const { data: perfis, error: erroPerfis } = await db.from('perfis').select('plano, storage_usado');
    if (erroPerfis) return res.status(500).json({ erro: erroPerfis.message });

    const { data: leads, error: erroLeads } = await db.from('leads').select('status, score, origem, plano_recomendado');
    // Se a tabela de leads ainda nao existir, nao quebra o dashboard -- so retorna vazio
    const listaLeads = erroLeads ? [] : (leads || []);

    const totalUsuarios = perfis.length;
    const porPlano = { free: 0, free_fundador: 0, free_campanha: 0, basico: 0, essencial: 0, plus: 0, premium: 0 };
    let storageTotalUsado = 0;

    perfis.forEach(p => {
      const plano = p.plano || 'free';
      if (porPlano[plano] !== undefined) porPlano[plano]++;
      storageTotalUsado += p.storage_usado || 0;
    });

    const PRECOS_DASHBOARD = { basico: 4.99, essencial: 9.99, plus: 29.99, premium: 49.99 };
    const receitaMensal =
      (porPlano.basico * PRECOS_DASHBOARD.basico) +
      (porPlano.essencial * PRECOS_DASHBOARD.essencial) +
      (porPlano.plus * PRECOS_DASHBOARD.plus) +
      (porPlano.premium * PRECOS_DASHBOARD.premium);

    // ── Estatisticas de Leads ──
    const totalLeads = listaLeads.length;
    const porStatus = { novo: 0, em_conversa: 0, qualificado: 0, convertido: 0, perdido: 0 };
    const porOrigem = {};
    let somaScore = 0;

    listaLeads.forEach(l => {
      const status = l.status || 'novo';
      if (porStatus[status] !== undefined) porStatus[status]++;
      const origem = l.origem || 'organico';
      porOrigem[origem] = (porOrigem[origem] || 0) + 1;
      somaScore += l.score || 0;
    });

    const scoreMedio = totalLeads > 0 ? Math.round(somaScore / totalLeads) : 0;
    const taxaConversao = totalLeads > 0 ? Math.round((porStatus.convertido / totalLeads) * 100) : 0;

    res.json({
      ok: true,
      atualizadoEm: new Date().toISOString(),
      totalUsuarios,
      porPlano,
      storageTotalUsadoGB: (storageTotalUsado / (1024 ** 3)).toFixed(2),
      receitaMensalEstimada: receitaMensal.toFixed(2),
      leads: {
        total: totalLeads,
        porStatus,
        porOrigem,
        scoreMedio,
        taxaConversao,
      },
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============================================
// DASHBOARD EXECUTIVO — visão geral da empresa
// GET /api/admin/resumo
// ============================================
const PRECOS_MRR = { basico: 4.99, essencial: 9.99, plus: 29.99, premium: 49.99 };
const PLANOS_PAGOS = Object.keys(PRECOS_MRR);
const PLANOS_PROMO = ['free_fundador', 'free_campanha'];
const DIA_MS = 24 * 60 * 60 * 1000;
const GB_BYTES = 1024 ** 3;

// Dia no fuso de Brasília (UTC-3), formato AAAA-MM-DD
const chaveDiaBR = (ms) => new Date(ms - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Lê TODOS os usuários do Supabase Auth (paginado)
async function listarTodosUsuarios(db) {
  const todos = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const { data, error } = await db.auth.admin.listUsers({ page: pagina, perPage: 1000 });
    if (error) throw error;
    const lote = (data && data.users) || [];
    todos.push(...lote);
    if (lote.length < 1000) break;
  }
  return todos;
}

// Esconde parte do e-mail (o endpoint é aberto, então não expomos e-mails completos)
function mascararEmail(email) {
  if (!email || !email.includes('@')) return '—';
  const [usuario, dominio] = email.split('@');
  return usuario.slice(0, 2) + '***@' + dominio;
}

// E-mails completos só aparecem se a variável ADMIN_TOKEN existir e o painel enviar o mesmo token
function tokenAdminValido(req) {
  const esperado = process.env.ADMIN_TOKEN || '';
  const recebido = String(req.headers['x-admin-token'] || '');
  if (!esperado || !recebido) return false;
  const a = Buffer.from(esperado), b = Buffer.from(recebido);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

app.get('/api/admin/resumo', async (req, res) => {
  try {
    const db = getDB();
    const emailCompleto = tokenAdminValido(req);
    const agora = Date.now();
    const t0 = Date.now();

    const [usuarios, perfisRes] = await Promise.all([
      listarTodosUsuarios(db),
      db.from('perfis').select('id, plano, storage_usado, plano_expira_em'),
    ]);
    if (perfisRes.error) throw perfisRes.error;
    const perfis = perfisRes.data || [];
    const latenciaMs = Date.now() - t0;

    const perfilPorId = new Map(perfis.map(p => [p.id, p]));

    // ── Usuários: ativos x inativos (ativo = entrou nos últimos 30 dias) ──
    const totalUsuarios = usuarios.length;
    let ativos = 0;
    usuarios.forEach(u => {
      const ultimo = u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : 0;
      if (ultimo && agora - ultimo <= 30 * DIA_MS) ativos++;
    });
    const inativos = totalUsuarios - ativos;

    // ── Novos cadastros: hoje / 7 dias / 30 dias + série diária de 30 dias ──
    const contagemPorDia = {};
    let novos7 = 0, novos30 = 0, novos30Anteriores = 0;
    usuarios.forEach(u => {
      const criado = Date.parse(u.created_at);
      if (!criado) return;
      const k = chaveDiaBR(criado);
      contagemPorDia[k] = (contagemPorDia[k] || 0) + 1;
      const idade = agora - criado;
      if (idade <= 7 * DIA_MS) novos7++;
      if (idade <= 30 * DIA_MS) novos30++;
      else if (idade <= 60 * DIA_MS) novos30Anteriores++;
    });
    const cadastrosPorDia = [];
    for (let i = 29; i >= 0; i--) {
      const k = chaveDiaBR(agora - i * DIA_MS);
      cadastrosPorDia.push({ data: k, cadastros: contagemPorDia[k] || 0 });
    }
    const novosHoje = contagemPorDia[chaveDiaBR(agora)] || 0;

    // ── Assinaturas, MRR, churn e armazenamento ──
    const porPlano = {};
    const mrrPorPlano = {};
    let gratuitas = 0, pagas = 0, vencidas = 0;
    let mrr = 0, churn30 = 0, receitaPerdida = 0;
    let storageUsado = 0, cotaAlocada = 0;

    perfis.forEach(p => {
      const plano = p.plano || 'free';
      const expira = p.plano_expira_em ? Date.parse(p.plano_expira_em) : null;
      const pago = PLANOS_PAGOS.includes(plano);
      const venceu = !!expira && expira < agora;

      let planoEfetivo = plano;
      if (pago && venceu) {
        vencidas++;
        planoEfetivo = 'free';
        if (agora - expira <= 30 * DIA_MS) { churn30++; receitaPerdida += PRECOS_MRR[plano]; }
      } else if (pago) {
        pagas++;
        mrr += PRECOS_MRR[plano];
        mrrPorPlano[plano] = (mrrPorPlano[plano] || 0) + PRECOS_MRR[plano];
      } else {
        gratuitas++;
        if (PLANOS_PROMO.includes(plano) && venceu) planoEfetivo = 'free';
      }

      porPlano[planoEfetivo] = (porPlano[planoEfetivo] || 0) + 1;
      storageUsado += p.storage_usado || 0;
      cotaAlocada += PLANOS[planoEfetivo] || PLANOS.free;
    });

    const baseChurn = pagas + churn30;
    const taxaChurn = baseChurn > 0 ? Math.round((churn30 / baseChurn) * 1000) / 10 : 0;

    // ── Capacidade: usa CAPACIDADE_TOTAL_GB (limite real do Supabase) se existir; senão soma das cotas ──
    const capacidadeEnv = Number(process.env.CAPACIDADE_TOTAL_GB);
    const capacidadeBytes = capacidadeEnv > 0 ? capacidadeEnv * GB_BYTES : cotaAlocada;
    const capacidadeFonte = capacidadeEnv > 0 ? 'infraestrutura' : 'cotas';
    const percentualStorage = capacidadeBytes > 0 ? Math.round((storageUsado / capacidadeBytes) * 1000) / 10 : 0;

    // ── Número de arquivos (precisa da função SQL admin_contar_arquivos; se não existir, vem null) ──
    let totalArquivos = null;
    try {
      const { data, error } = await db.rpc('admin_contar_arquivos');
      if (!error && data !== null && data !== undefined) totalArquivos = Number(data);
    } catch (e) { /* ignora */ }

    // ── Crescimento ──
    const baseUsuarios30dAtras = totalUsuarios - novos30;
    const crescimentoUsuarios30d = baseUsuarios30dAtras > 0
      ? Math.round((novos30 / baseUsuarios30dAtras) * 1000) / 10
      : (novos30 > 0 ? 100 : 0);
    const variacaoCadastros = novos30Anteriores > 0
      ? Math.round(((novos30 - novos30Anteriores) / novos30Anteriores) * 100)
      : null;

    // ── Saúde operacional / alertas ──
    const alertas = [];
    if (percentualStorage >= 90) alertas.push({ nivel: 'critico', texto: `Armazenamento em ${percentualStorage}% — ação necessária` });
    else if (percentualStorage >= 80) alertas.push({ nivel: 'atencao', texto: `Armazenamento em ${percentualStorage}% da capacidade` });
    if (taxaChurn >= 20) alertas.push({ nivel: 'critico', texto: `Cancelamento (churn) em ${taxaChurn}%` });
    else if (taxaChurn >= 10) alertas.push({ nivel: 'atencao', texto: `Cancelamento (churn) em ${taxaChurn}%` });
    if (latenciaMs > 3000) alertas.push({ nivel: 'atencao', texto: `Banco de dados lento (${latenciaMs} ms)` });
    if (totalUsuarios > 0 && novos7 === 0) alertas.push({ nivel: 'atencao', texto: 'Nenhum cadastro nos últimos 7 dias' });
    const status = alertas.some(a => a.nivel === 'critico') ? 'critico'
                 : alertas.length ? 'atencao' : 'ok';

    // ── Últimos cadastros ──
    const ultimosCadastros = [...usuarios]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 8)
      .map(u => {
        const p = perfilPorId.get(u.id) || {};
        const ultimo = u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : 0;
        return {
          email: emailCompleto ? (u.email || '—') : mascararEmail(u.email),
          plano: p.plano || 'free',
          criadoEm: u.created_at,
          ultimoAcesso: u.last_sign_in_at || null,
          ativo: !!ultimo && agora - ultimo <= 30 * DIA_MS,
        };
      });

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      geradoEm: new Date(agora).toISOString(),
      saude: { status, latenciaMs, alertas },
      usuarios: { total: totalUsuarios, ativos, inativos },
      cadastros: { hoje: novosHoje, ultimos7dias: novos7, ultimos30dias: novos30, anteriores30dias: novos30Anteriores, variacaoPercentual: variacaoCadastros, porDia: cadastrosPorDia },
      assinaturas: { gratuitas, pagas, vencidas, porPlano, mrrPorPlano: Object.fromEntries(Object.entries(mrrPorPlano).map(([k, v]) => [k, Math.round(v * 100) / 100])) },
      receita: { mrr: Math.round(mrr * 100) / 100, arr: Math.round(mrr * 12 * 100) / 100 },
      churn: { taxa: taxaChurn, cancelados30dias: churn30, receitaPerdida: Math.round(receitaPerdida * 100) / 100 },
      armazenamento: {
        usadoBytes: storageUsado,
        capacidadeBytes,
        capacidadeFonte,
        percentual: percentualStorage,
        totalArquivos,
      },
      crescimento: { usuarios30dPercentual: crescimentoUsuarios30d, novos30dias: novos30, variacaoCadastros },
      emailCompleto,
      ultimosCadastros,
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ============================================
// ROTAS DE CAMPANHAS
// ============================================

app.get('/api/campanhas', async (req, res) => {
  const db = getDB();
  const { data, error } = await db.from('campanhas').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.post('/api/campanhas', async (req, res) => {
  const { nome, canal, orcamento, data_inicio, data_fim, observacoes } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatorio' });
  const db = getDB();
  const { data, error } = await db.from('campanhas').insert({
    nome,
    canal: canal || 'organico',
    orcamento: orcamento || 0,
    data_inicio: data_inicio || new Date().toISOString().slice(0, 10),
    data_fim: data_fim || null,
    observacoes: observacoes || null,
    status: 'ativa',
    cliques: 0,
    conversoes: 0,
  }).select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true, campanha: data });
});

app.patch('/api/campanhas/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, canal, status, orcamento, cliques, conversoes, data_fim, observacoes } = req.body;
  const db = getDB();
  const campos = {};
  if (nome !== undefined) campos.nome = nome;
  if (canal !== undefined) campos.canal = canal;
  if (status !== undefined) campos.status = status;
  if (orcamento !== undefined) campos.orcamento = orcamento;
  if (cliques !== undefined) campos.cliques = cliques;
  if (conversoes !== undefined) campos.conversoes = conversoes;
  if (data_fim !== undefined) campos.data_fim = data_fim;
  if (observacoes !== undefined) campos.observacoes = observacoes;

  const { data, error } = await db.from('campanhas').update(campos).eq('id', id).select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true, campanha: data });
});

app.delete('/api/campanhas/:id', async (req, res) => {
  const { id } = req.params;
  const db = getDB();
  const { error } = await db.from('campanhas').delete().eq('id', id);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

// ============================================
// CHATBOT COM IA (Groq)
// ============================================

const SYSTEM_PROMPT_CLOUDX = `Você é o assistente virtual da CloudX, um serviço de armazenamento em nuvem no Brasil.

INFORMAÇÕES SOBRE OS PLANOS:
- Free: R$ 0/ano, 1 GB de armazenamento
- CAMPANHA POR TEMPO LIMITADO (72 horas): 20 GB grátis por 6 meses para quem criar conta, sem cartão de crédito. Depois que a campanha acabar, a promoção "Experimente" volta a ser de 2 GB grátis por 6 meses.
- Básico: R$ 4,99/mês, 30 GB
- Essencial: R$ 9,99/mês, 100 GB
- Plus: R$ 29,99/mês, 300 GB
- Premium: R$ 49,99/mês, 1 TB (1024 GB)

REGRAS DE COMPORTAMENTO:
- Seja breve, direto e simpático. Respostas de no máximo 3-4 frases.
- Responda sempre em português do Brasil.
- Se o usuário demonstrar interesse real (perguntar sobre preço, querer assinar, pedir contato humano), pergunte o nome e e-mail dele educadamente para que a equipe entre em contato.
- Não invente informações que não foram passadas aqui. Se não souber algo, diga que vai encaminhar para a equipe humana.
- Nunca peça senha, dados de cartão de crédito, ou informações sensíveis.`;

async function chamarGroq(mensagens) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: SYSTEM_PROMPT_CLOUDX }, ...mensagens],
      temperature: 0.6,
      max_tokens: 300,
    }),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Groq API erro: ${resp.status} - ${erro}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content;
}

app.post('/api/chatbot', async (req, res) => {
  try {
    const { mensagens } = req.body;
    if (!mensagens || !Array.isArray(mensagens) || mensagens.length === 0) {
      return res.status(400).json({ erro: 'Envie ao menos uma mensagem' });
    }

    const resposta = await chamarGroq(mensagens);
    res.json({ ok: true, resposta });
  } catch (e) {
    console.error('Erro no chatbot:', e.message);
    res.status(500).json({ erro: 'Não foi possível gerar resposta agora. Tente novamente.' });
  }
});

// Captura o lead direto da conversa do chatbot (quando o usuário deixa nome/email no chat)
app.post('/api/chatbot/lead', async (req, res) => {
  const { nome, email, telefone, mensagem } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatorio' });
  const db = getDB();
  const { data, error } = await db.from('leads').insert({
    nome, email, telefone,
    origem: 'chat',
    mensagem: mensagem || 'Lead capturado via chatbot do site',
    status: 'novo',
    score: 30, // leads via chat já demonstraram interesse ativo, entram com score maior
  }).select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true, lead: data });
});

// ============================================
// ANALYTICS DE VISITANTES
// ============================================

// ── Filtros para só contar visita HUMANA ──
// Robôs (Google, monitores de uptime, prévia de link, scripts) não entram na contagem
const REGEX_BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|facebookexternalhit|whatsapp|telegram|preview|curl|wget|python-requests|axios|node-fetch|undici|^node$|go-http|java\//i;
const VISITOR_ID_OK = /^v_\d{10,15}_[a-z0-9]{1,30}$/;   // formato gerado pelo site
const pareceBot = (req) => { const ua = String(req.headers['user-agent'] || ''); return !ua || REGEX_BOT.test(ua); };
const OFFSET_BR = 3 * 60 * 60 * 1000;                     // Brasília = UTC-3
// Visita válida = não é robô + id no formato do site + o site confirmou interação humana (humano: true)
const visitaInvalida = (req, vid) => pareceBot(req) || !req.body || req.body.humano !== true || !VISITOR_ID_OK.test(String(vid));

// Registra uma visualizacao de pagina + marca o visitante como online
app.post('/api/analytics/pageview', async (req, res) => {
  const { visitor_id, pagina, referrer } = req.body || {};
  if (!visitor_id || !pagina) return res.status(400).json({ erro: 'visitor_id e pagina obrigatorios' });
  if (visitaInvalida(req, visitor_id)) return res.json({ ok: true, ignorado: true });
  const db = getDB();
  const linha = { visitor_id, pagina: String(pagina).slice(0, 200), referrer: referrer ? String(referrer).slice(0, 300) : null };

  // Guarda o navegador para auditoria (se a coluna user_agent existir); senão grava sem ela
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  let { error } = await db.from('page_views').insert({ ...linha, user_agent: ua });
  if (error) await db.from('page_views').insert(linha);
  await db.from('visitantes_online').upsert({ visitor_id, pagina: linha.pagina, updated_at: new Date().toISOString() });

  res.json({ ok: true });
});

// Heartbeat: o site chama isso a cada ~20s enquanto a aba estiver aberta, pra manter o "online" atualizado
app.post('/api/analytics/heartbeat', async (req, res) => {
  const { visitor_id, pagina } = req.body || {};
  if (!visitor_id) return res.status(400).json({ erro: 'visitor_id obrigatorio' });
  if (visitaInvalida(req, visitor_id)) return res.json({ ok: true, ignorado: true });
  const db = getDB();

  await db.from('visitantes_online').upsert({ visitor_id, pagina: pagina || null, updated_at: new Date().toISOString() });
  res.json({ ok: true });
});

// Estatisticas para o dashboard
app.get('/api/analytics/stats', async (req, res) => {
  try {
    const db = getDB();
    const agora = new Date();
    const diaBR = new Date(agora.getTime() - OFFSET_BR);
    const inicioHoje = new Date(Date.UTC(diaBR.getUTCFullYear(), diaBR.getUTCMonth(), diaBR.getUTCDate()) + OFFSET_BR).toISOString();
    const cincoMinAtras = new Date(agora.getTime() - 5 * 60 * 1000).toISOString();
    const trintaDiasAtras = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Total de visualizacoes hoje
    const { count: visitasHoje } = await db.from('page_views').select('id', { count: 'exact', head: true }).gte('created_at', inicioHoje);

    // Total de visualizacoes de sempre
    const { count: visitasTotal } = await db.from('page_views').select('id', { count: 'exact', head: true });

    // Visitantes online agora (heartbeat nos ultimos 5 minutos)
    const { count: onlineAgora } = await db.from('visitantes_online').select('visitor_id', { count: 'exact', head: true }).gte('updated_at', cincoMinAtras);

    // Visitantes unicos hoje
    const { data: visitantesHojeData } = await db.from('page_views').select('visitor_id').gte('created_at', inicioHoje);
    const visitantesUnicosHoje = new Set((visitantesHojeData || []).map(v => v.visitor_id)).size;

    // Paginas mais acessadas (ultimos 30 dias)
    const { data: paginasData } = await db.from('page_views').select('pagina').gte('created_at', trintaDiasAtras);
    const contagemPaginas = {};
    (paginasData || []).forEach(p => { contagemPaginas[p.pagina] = (contagemPaginas[p.pagina] || 0) + 1; });
    const paginasMaisAcessadas = Object.entries(contagemPaginas)
      .map(([pagina, visitas]) => ({ pagina, visitas }))
      .sort((a, b) => b.visitas - a.visitas)
      .slice(0, 8);

    // Visitas por dia (ultimos 14 dias, para o grafico)
    const catorzeDiasAtras = new Date(agora.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: visitasPorDiaData } = await db.from('page_views').select('created_at').gte('created_at', catorzeDiasAtras);
    const contagemPorDia = {};
    (visitasPorDiaData || []).forEach(v => {
      const dia = new Date(Date.parse(v.created_at) - OFFSET_BR).toISOString().slice(0, 10); // AAAA-MM-DD (Brasília)
      contagemPorDia[dia] = (contagemPorDia[dia] || 0) + 1;
    });
    // Preenche os 14 dias mesmo os que tiveram 0 visitas, para o grafico ficar completo
    const visitasPorDia = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(agora.getTime() - i * 24 * 60 * 60 * 1000);
      const chave = new Date(d.getTime() - OFFSET_BR).toISOString().slice(0, 10);
      visitasPorDia.push({ data: chave, visitas: contagemPorDia[chave] || 0 });
    }

    res.json({
      ok: true,
      visitasHoje: visitasHoje || 0,
      visitasTotal: visitasTotal || 0,
      onlineAgora: onlineAgora || 0,
      visitantesUnicosHoje,
      paginasMaisAcessadas,
      visitasPorDia,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// E-mail marketing pelo Gmail (rotas /api/admin/email/* e /api/email/descadastrar)
require('../email-marketing')(app, { getDB, listarTodosUsuarios, tokenAdminValido });
