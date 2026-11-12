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


// ── REGIÃO (cidade/UF/país) a partir dos headers que a Vercel adiciona pelo IP do visitante ──
// Não guardamos o IP, só a localização aproximada.
const lerHeader = (req, nome) => {
  let v = req.headers[nome];
  if (Array.isArray(v)) v = v[0];
  if (!v) return null;
  try { v = decodeURIComponent(String(v)); } catch (e) { v = String(v); }
  v = v.trim().slice(0, 80);
  return v || null;
};
const regiaoDaRequisicao = (req) => ({
  cidade: lerHeader(req, 'x-vercel-ip-city'),
  estado: lerHeader(req, 'x-vercel-ip-country-region'),
  pais:   lerHeader(req, 'x-vercel-ip-country'),
});
// Lê TODAS as linhas de uma consulta do Supabase (o limite padrão é 1000 por chamada). Ate 20000 linhas.
// criar(ini, fim) deve devolver a consulta ja com .range(ini, fim)
async function buscarTudo(criar) {
  const tudo = [];
  for (let ini = 0; ini < 20000; ini += 1000) {
    const { data, error } = await criar(ini, ini + 999);
    if (error) return { data: null, error };
    if (!data || !data.length) break;
    tudo.push(...data);
    if (data.length < 1000) break;
  }
  return { data: tudo, error: null };
}

// ── ORIGEM DO TRÁFEGO: de onde veio o visitante (utm_source do link, senão o referrer) ──
const ORIGENS_CONHECIDAS = [
  [/(^|\.)google\./, 'Google'], [/(^|\.)bing\./, 'Bing'], [/duckduckgo/, 'DuckDuckGo'], [/yahoo/, 'Yahoo'],
  [/instagram/, 'Instagram'], [/facebook|^fb\.|^m\.me$/, 'Facebook'], [/whatsapp|^wa\.me$/, 'WhatsApp'],
  [/youtube|^youtu\.be$/, 'YouTube'], [/tiktok/, 'TikTok'], [/linkedin|^lnkd\.in$/, 'LinkedIn'],
  [/^t\.co$|twitter|^x\.com$/, 'X / Twitter'], [/^t\.me$|telegram/, 'Telegram'], [/pinterest/, 'Pinterest'], [/reddit/, 'Reddit'],
];
function classificarOrigem(referrer, utm) {
  const nomeAmigavel = (txt) => {
    const t = String(txt).toLowerCase().trim();
    const achou = ORIGENS_CONHECIDAS.find(([re]) => re.test(t));
    return achou ? achou[1] : (t.charAt(0).toUpperCase() + t.slice(1));
  };
  if (utm && String(utm).trim()) return nomeAmigavel(String(utm).slice(0, 40));
  if (!referrer) return 'Direto';
  let host = '';
  try { host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return 'Direto'; }
  if (!host || /cloudx/i.test(host)) return 'Direto';   // navegação interna do próprio site
  const achou = ORIGENS_CONHECIDAS.find(([re]) => re.test(host));
  return achou ? achou[1] : host;
}

// ── DISPOSITIVO: tipo, sistema e navegador a partir do user-agent (devolve null para robôs) ──
function classificarDispositivo(ua) {
  const u = String(ua || '');
  if (!u || /bot|crawl|spider|slurp|headless|preview|monitor|lighthouse|curl|wget|python|node-fetch|axios/i.test(u)) return null;
  const ios = /iPhone|iPod/.test(u), ipad = /iPad/.test(u), android = /Android/i.test(u);
  let tipo = 'Computador';
  if (ipad || (android && !/Mobile/i.test(u)) || /Tablet/i.test(u)) tipo = 'Tablet';
  else if (ios || (android && /Mobile/i.test(u)) || /Mobile|Windows Phone/i.test(u)) tipo = 'Celular';
  let sistema = 'Outros';
  if (ios || ipad) sistema = 'iOS';
  else if (android) sistema = 'Android';
  else if (/Windows/i.test(u)) sistema = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(u)) sistema = 'macOS';
  else if (/CrOS/.test(u)) sistema = 'ChromeOS';
  else if (/Linux|X11/i.test(u)) sistema = 'Linux';
  let navegador = 'Outros';
  if (/Edg(e|A|iOS)?\//.test(u)) navegador = 'Edge';
  else if (/OPR\/|Opera/.test(u)) navegador = 'Opera';
  else if (/SamsungBrowser/.test(u)) navegador = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/.test(u)) navegador = 'Firefox';
  else if (/CriOS|Chrome\//.test(u)) navegador = 'Chrome';
  else if (/Safari\//.test(u)) navegador = 'Safari';
  return { tipo, sistema, navegador };
}

// Agrupa uma lista [{cidade, estado}] em ranking {nome, total}
const rankingPor = (lista, chave, limite = 8) => {
  const cont = {};
  lista.forEach(i => { const k = chave(i); if (k) cont[k] = (cont[k] || 0) + 1; });
  return Object.entries(cont).map(([nome, total]) => ({ nome, total })).sort((a, b) => b.total - a.total).slice(0, limite);
};

// ── PLANOS E LIMITES (em bytes) ──
const PLANOS = {
  free:           1   * 1024 * 1024 * 1024,   // 1 GB (padrão, após expirar a promo)
  free_fundador:  2   * 1024 * 1024 * 1024,   // 2 GB — promo "Experimente", válida por 6 meses, sem limite de vagas
  free_campanha:  20  * 1024 * 1024 * 1024,   // 20 GB — CAMPANHA por tempo limitado (72h), válida por 6 meses
  free_blackfriday: 15 * 1024 * 1024 * 1024,  // 15 GB — BLACK FRIDAY, válida por 6 meses
  basico:         30  * 1024 * 1024 * 1024,   // 30 GB
  essencial:      100 * 1024 * 1024 * 1024,   // 100 GB
  plus:           300 * 1024 * 1024 * 1024,   // 300 GB
  premium:        1024 * 1024 * 1024 * 1024,  // 1 TB
};

// ── CAMPANHA BLACK FRIDAY 15 GB ──
// Defina PROMO_CAMPANHA_FIM (ISO 8601, ex.: 2026-11-30T23:59:59-03:00) nas variáveis de ambiente
// para controlar o fim da campanha sem mexer no código. Ex.: hora da publicação + 72h.
const CAMPANHA_FIM = new Date(process.env.PROMO_CAMPANHA_FIM || '2026-11-30T23:59:59-03:00');
const campanhaAtiva = () => Date.now() < CAMPANHA_FIM.getTime();

// Público: o front usa para montar o contador (usa a hora do servidor, não a do aparelho)
app.get('/api/promo/campanha', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ativa: campanhaAtiva(),
    fim: CAMPANHA_FIM.toISOString(),
    agora: new Date().toISOString(),
    gb: campanhaAtiva() ? 15 : 2,
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
  if (['free_fundador', 'free_campanha', 'free_blackfriday'].includes(perfil.plano) && perfil.plano_expira_em && new Date(perfil.plano_expira_em) < new Date()) {
    await db.from('perfis').update({ plano: 'free', plano_expira_em: null }).eq('id', perfil.id);
    perfil.plano = 'free';
    perfil.plano_expira_em = null;
  }
  return perfil;
}

app.get('/api/perfil', auth, async (req, res) => {
  const { data, error } = await req.db.from('perfis').select('*').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ erro: error.message });
  // Região: preenche no cadastro/1º acesso (e nos clientes antigos, no próximo login)
  if (!data.cidade && !data.estado) {
    const reg = regiaoDaRequisicao(req);
    if (reg.cidade || reg.estado) {
      try { await getDB().from('perfis').update(reg).eq('id', req.user.id); Object.assign(data, reg); } catch (e) { /* colunas ainda não criadas: ignora */ }
    }
  }
  const perfil = await resolverPlanoAtual(req.db, data);
  const limite = PLANOS[perfil.plano] || PLANOS.free;
  res.json({ ...perfil, limite, percentual: Math.round((perfil.storage_usado / limite) * 100) });
});

// ── Chamado uma vez no cadastro (signup) para aplicar a promo "Experimente" (2GB/6 meses, sem limite de vagas) ──
app.post('/api/promo/fundador', auth, async (req, res) => {
  const { data: perfil } = await req.db.from('perfis').select('id, plano').eq('id', req.user.id).single();
  if (!perfil) return res.status(404).json({ erro: 'Perfil não encontrado' });

  // Região do cliente no momento do cadastro
  const regCad = regiaoDaRequisicao(req);
  if (regCad.cidade || regCad.estado) {
    try { await getDB().from('perfis').update(regCad).eq('id', req.user.id); } catch (e) { /* ignora */ }
  }

  // Já tem algum plano definido (não é o primeiro contato) — não reaplica
  if (perfil.plano && perfil.plano !== 'free') {
    return res.json({ aplicado: false, motivo: 'Perfil já possui um plano' });
  }

  // Durante a Black Friday: 15 GB. Depois que acabar: volta ao "Experimente" de 2 GB.
  const plano = campanhaAtiva() ? 'free_blackfriday' : 'free_fundador';
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

    // Registra o pagamento (id único). Se o Mercado Pago avisar de novo, não renova em dobro.
    // Se a tabela ainda não existe (pagamentos.sql não rodado), segue como antes para nunca travar uma venda.
    let pagamentoRegistrado = false;
    const { error: erroReg } = await db.from('pagamentos').insert({
      mp_payment_id: String(data.id), user_id: userId, plano,
      valor: Number(pagamento.transaction_amount) || (PRECOS_MRR[plano] || 0),
      pago_em: pagamento.date_approved || new Date().toISOString(), origem: 'webhook',
    });
    if (!erroReg) pagamentoRegistrado = true;
    else if (erroReg.code === '23505') return res.sendStatus(200);   // já processado antes

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

    const { error: erroPerfil } = await db.from('perfis').update({
      plano,
      plano_expira_em: novaExpiracao.toISOString(),
      ultimo_pagamento_id: String(data.id),
    }).eq('id', userId);
    if (erroPerfil) {
      // não deixa o pagamento marcado como processado: o Mercado Pago vai tentar de novo
      if (pagamentoRegistrado) await db.from('pagamentos').delete().eq('mp_payment_id', String(data.id));
      return res.sendStatus(500);
    }

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
app.get("/favicon-32.png", (req, res) => { res.sendFile(path.join(root, "favicon-32.png")); });
app.get("/favicon-16.png", (req, res) => { res.sendFile(path.join(root, "favicon-16.png")); });
app.get("/apple-touch-icon.png", (req, res) => { res.sendFile(path.join(root, "apple-touch-icon.png")); });
app.get("/icon-maskable-512.png", (req, res) => { res.sendFile(path.join(root, "icon-maskable-512.png")); });
app.get("/sucesso", (req, res) => { res.sendFile(path.join(root, "sucesso.html")); });
app.get("/sucesso", (req, res) => { res.sendFile(require("path").join(__dirname, "../sucesso.html")); });
app.get("/erro", (req, res) => { res.send('<html><body style="font-family:sans-serif;text-align:center;padding:80px"><h1>❌ Pagamento não concluído</h1><p>Tente novamente.</p><a href="/">← Voltar</a></body></html>'); });
app.get("/pendente", (req, res) => { res.send('<html><body style="font-family:sans-serif;text-align:center;padding:80px"><h1>⏳ Pagamento pendente</h1><p>Aguardando confirmação. Seu plano será ativado em breve.</p><a href="/">← Voltar</a></body></html>'); });

module.exports = app;


// ============================================
// ROTAS DE LEADS / CRM
// ============================================

// Lista todos os leads (usado pelo dashboard admin)
app.get('/api/leads', exigirAdminApi, async (req, res) => {
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
app.patch('/api/leads/:id', exigirAdminApi, async (req, res) => {
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
app.delete('/api/leads/:id', exigirAdminApi, async (req, res) => {
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

app.get('/dashboard/stats', exigirAdminApi, async (req, res) => {
  try {
    const db = getDB();

    const { data: perfis, error: erroPerfis } = await db.from('perfis').select('plano, storage_usado');
    if (erroPerfis) return res.status(500).json({ erro: erroPerfis.message });

    const { data: leads, error: erroLeads } = await db.from('leads').select('status, score, origem, plano_recomendado');
    // Se a tabela de leads ainda nao existir, nao quebra o dashboard -- so retorna vazio
    const listaLeads = erroLeads ? [] : (leads || []);

    const totalUsuarios = perfis.length;
    const porPlano = { free: 0, free_fundador: 0, free_campanha: 0, free_blackfriday: 0, basico: 0, essencial: 0, plus: 0, premium: 0 };
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
const PLANOS_PROMO = ['free_fundador', 'free_campanha', 'free_blackfriday'];
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
// Exige o ADMIN_TOKEN (cabeçalho x-admin-token). Protege tudo que o painel /admin lê ou altera.
// Rotas públicas continuam abertas: cadastro de lead, chatbot, pageview/heartbeat e as rotas dos clientes.
function exigirAdminApi(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ADMIN_TOKEN) return res.status(503).json({ ok: false, erro: 'ADMIN_TOKEN não configurada na Vercel.' });
  if (tokenAdminValido(req)) return next();
  // pequena pausa nas tentativas erradas para dificultar adivinhar o token
  setTimeout(() => res.status(401).json({ ok: false, erro: 'Token de admin inválido.' }), 500);
}

// Importa o histórico de pagamentos aprovados do Mercado Pago para a tabela pagamentos (seguro repetir: não duplica)
app.post('/api/admin/pagamentos/importar-mp', exigirAdminApi, async (req, res) => {
  try {
    if (!process.env.MP_ACCESS_TOKEN) return res.status(400).json({ ok: false, erro: 'MP_ACCESS_TOKEN não configurada na Vercel.' });
    const db = getDB();
    const POR_PAGINA = 50, PAGINAS = 4;           // 200 pagamentos por chamada (cabe no tempo da Vercel)
    const inicio = Math.max(0, Number((req.body || {}).offset) || 0);
    let lidos = 0, gravados = 0, fim = false;
    for (let i = 0; i < PAGINAS; i++) {
      const off = inicio + i * POR_PAGINA;
      const r = await mp.listarPagamentos(off, POR_PAGINA);
      const lista = r.results || [];
      const linhas = lista.filter(p => p.status === 'approved').map(p => {
        const [userId, plano] = String(p.external_reference || '').split('|');
        if (!userId || !PRECOS_MRR[plano]) return null;          // ignora pagamentos que não são de plano do CloudX
        return { mp_payment_id: String(p.id), user_id: userId, plano, valor: Number(p.transaction_amount) || PRECOS_MRR[plano], pago_em: p.date_approved || p.date_created, origem: 'mercadopago' };
      }).filter(Boolean);
      if (linhas.length) {
        const { error } = await db.from('pagamentos').upsert(linhas, { onConflict: 'mp_payment_id', ignoreDuplicates: true });
        if (error) return res.status(409).json({ ok: false, erro: error.message.includes('pagamentos') ? 'Tabela pagamentos não existe. Rode pagamentos.sql no Supabase.' : error.message });
        gravados += linhas.length;
      }
      lidos += lista.length;
      const total = (r.paging && r.paging.total) || 0;
      if (lista.length < POR_PAGINA || off + POR_PAGINA >= total) { fim = true; break; }
    }
    res.json({ ok: true, lidos, gravados, proximoOffset: inicio + PAGINAS * POR_PAGINA, fim });
  } catch (e) { res.status(500).json({ ok: false, erro: 'Falha ao consultar o Mercado Pago: ' + e.message }); }
});

// ── EXPORTAÇÃO CSV (separador ";" e BOM UTF-8: abre direto no Excel/Planilhas em português, com acentos certos) ──
const ROTULO_PLANO = { free: 'Gratuito', free_fundador: 'Free Fundador', free_campanha: 'Free Campanha', free_blackfriday: 'Black Friday', basico: 'Básico', essencial: 'Essencial', plus: 'Plus', premium: 'Premium' };
function celulaCsv(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;                 // evita que o Excel execute como fórmula
  return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
const montarCsv = (cab, linhas) => '\ufeff' + [cab, ...linhas].map(l => l.map(celulaCsv).join(';')).join('\r\n') + '\r\n';
function dataBR(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!ms) return '';
  const d = new Date(ms - OFFSET_BR).toISOString();            // AAAA-MM-DDTHH:MM (horário de Brasília)
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 16)}`;
}
async function carregarClientesParaExportar(db) {
  const [usuarios, perfisRes] = await Promise.all([
    listarTodosUsuarios(db),
    db.from('perfis').select('id, plano, storage_usado, plano_expira_em, cidade, estado, pais'),
  ]);
  let perfisR = perfisRes;
  if (perfisRes.error) { perfisR = await db.from('perfis').select('id, plano, storage_usado, plano_expira_em'); if (perfisR.error) throw perfisR.error; }
  let arq = null;
  try { const r = await buscarTudo((a, b) => db.rpc('admin_arquivos_por_usuario').range(a, b)); if (!r.error && r.data) arq = new Map(r.data.map(x => [String(x.user_id), x])); } catch (e) { /* função não criada */ }
  return { usuarios, perfis: perfisR.data || [], arq };
}

app.get('/api/admin/exportar/:tipo', exigirAdminApi, async (req, res) => {
  try {
    const tipo = req.params.tipo, db = getDB(), agora = Date.now();
    let cab, linhas;
    if (tipo === 'leads') {
      const { data, error } = await db.from('leads').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      cab = ['Nome', 'E-mail', 'Telefone', 'Origem', 'Status', 'Score', 'Plano recomendado', 'Mensagem', 'Criado em'];
      linhas = (data || []).map(l => [l.nome, l.email, l.telefone, l.origem, l.status, l.score, l.plano_recomendado, l.mensagem, dataBR(l.created_at)]);
    } else if (tipo === 'clientes' || tipo === 'sem-arquivo') {
      const { usuarios, perfis, arq } = await carregarClientesParaExportar(db);
      const perfilPorId = new Map(perfis.map(p => [p.id, p]));
      let lista = usuarios.map(u => {
        const p = perfilPorId.get(u.id) || {};
        const plano = p.plano || 'free', exp = p.plano_expira_em ? Date.parse(p.plano_expira_em) : null;
        const venceu = !!exp && exp < agora;
        const efetivo = (PLANOS_PAGOS.includes(plano) || PLANOS_PROMO.includes(plano)) && venceu ? 'free' : plano;
        const usado = p.storage_usado || 0, limite = PLANOS[efetivo] || PLANOS.free;
        const info = arq ? (arq.get(String(u.id)) || { arquivos: 0 }) : null;
        const enviou = arq ? Number(info.arquivos) > 0 : usado > 0;
        return { u, p, efetivo, venceu, usado, limite, qtd: info ? Number(info.arquivos) : null, enviou, cadastro: Date.parse(u.created_at) || 0 };
      });
      if (tipo === 'sem-arquivo') lista = lista.filter(c => !c.enviou);
      lista.sort((a, b) => b.cadastro - a.cadastro);
      cab = ['E-mail', 'Nome', 'Plano atual', 'Plano contratado', 'Plano vence em', 'Cadastro', 'Último acesso', 'Cidade', 'Estado', 'Enviou arquivo', 'Arquivos', 'Usado (MB)', 'Limite (GB)', 'Uso (%)'];
      linhas = lista.map(c => [
        c.u.email, (c.u.user_metadata && (c.u.user_metadata.nome || c.u.user_metadata.full_name || c.u.user_metadata.name)) || '',
        ROTULO_PLANO[c.efetivo] || c.efetivo, (ROTULO_PLANO[c.p.plano || 'free'] || c.p.plano || '') + (c.venceu ? ' (vencido)' : ''),
        c.p.plano_expira_em ? dataBR(c.p.plano_expira_em) : '', dataBR(c.u.created_at), c.u.last_sign_in_at ? dataBR(c.u.last_sign_in_at) : 'Nunca',
        c.p.cidade || '', c.p.estado || '', c.enviou ? 'Sim' : 'Não', c.qtd == null ? '' : c.qtd,
        Math.round(c.usado / 1048576 * 100) / 100, Math.round(c.limite / 1073741824 * 100) / 100, Math.round(c.usado / c.limite * 1000) / 10,
      ]);
    } else if (tipo === 'regioes') {
      const { perfis } = await carregarClientesParaExportar(db);
      const noBr = (x) => !x.pais || String(x.pais).toUpperCase() === 'BR';
      const cont = new Map();
      const somar = (tipoLinha, estado, cidade) => { const k = [tipoLinha, estado || '', cidade || ''].join('|'); cont.set(k, (cont.get(k) || 0) + 1); };
      perfis.filter(p => (p.cidade || p.estado) && noBr(p)).forEach(p => somar('Cliente', p.estado, p.cidade));
      const trinta = new Date(agora - 30 * DIA_MS).toISOString();
      const rv = await buscarTudo((a, b) => db.from('page_views').select('visitor_id, cidade, estado, pais').gte('created_at', trinta).not('estado', 'is', null).order('id').range(a, b));
      if (!rv.error && rv.data) { const vistos = new Set(); rv.data.forEach(v => { if (noBr(v) && !vistos.has(v.visitor_id)) { vistos.add(v.visitor_id); somar('Visitante (30 dias)', v.estado, v.cidade); } }); }
      cab = ['Tipo', 'Estado', 'Cidade', 'Total'];
      linhas = [...cont.entries()].map(([k, n]) => [...k.split('|'), n]).sort((a, b) => a[0].localeCompare(b[0]) || b[3] - a[3]);
    } else {
      return res.status(404).json({ ok: false, erro: 'Tipo de exportação desconhecido.' });
    }
    const dia = new Date(agora - OFFSET_BR).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cloudx-${tipo}-${dia}.csv"`);
    res.send(montarCsv(cab, linhas));
  } catch (e) { res.status(500).json({ ok: false, erro: 'Falha ao exportar: ' + e.message }); }
});

// Usado pela tela de login do painel para conferir o token
app.get('/api/admin/verificar', exigirAdminApi, (req, res) => res.json({ ok: true }));

function tokenAdminValido(req) {
  const esperado = process.env.ADMIN_TOKEN || '';
  const recebido = String(req.headers['x-admin-token'] || '');
  if (!esperado || !recebido) return false;
  const a = Buffer.from(esperado), b = Buffer.from(recebido);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

app.get('/api/admin/resumo', exigirAdminApi, async (req, res) => {
  try {
    const db = getDB();
    const emailCompleto = tokenAdminValido(req);
    const agora = Date.now();
    const t0 = Date.now();

    const [usuarios, perfisRes] = await Promise.all([
      listarTodosUsuarios(db),
      db.from('perfis').select('id, plano, storage_usado, plano_expira_em, cidade, estado, pais'),
    ]);
    let perfisRegiao = perfisRes;
    if (perfisRes.error) {
      // Colunas de região ainda não criadas (regiao_clientes.sql não rodado): busca sem elas
      perfisRegiao = await db.from('perfis').select('id, plano, storage_usado, plano_expira_em');
      if (perfisRegiao.error) throw perfisRegiao.error;
    }
    const perfis = perfisRegiao.data || [];
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
    const candidatosUpgrade = [];

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
      const limiteBytes = PLANOS[planoEfetivo] || PLANOS.free;
      const pct = limiteBytes > 0 ? ((p.storage_usado || 0) / limiteBytes) * 100 : 0;
      if (pct >= 80) candidatosUpgrade.push({ id: p.id, plano: planoEfetivo, usadoBytes: p.storage_usado || 0, limiteBytes, percentual: Math.round(pct) });
    });
    const emailPorId = new Map(usuarios.map(u => [u.id, u.email]));
    const proximosLimite = candidatosUpgrade
      .sort((a, b) => b.percentual - a.percentual).slice(0, 15)
      .map(c => ({ email: emailPorId.get(c.id) || '—', plano: c.plano, usadoBytes: c.usadoBytes, limiteBytes: c.limiteBytes, percentual: c.percentual }));

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

    // ── Ativação, Black Friday e promoções vencendo ──
    const criadoPorId = new Map(usuarios.map(u => [u.id, Date.parse(u.created_at) || 0]));
    // Fonte da verdade: arquivos reais no Storage (admin_arquivos_por_usuario.sql). Sem a função, usa o armazenamento usado.
    let arquivosPorUsuario = null;
    try {
      const r = await buscarTudo((a, b) => db.rpc('admin_arquivos_por_usuario').range(a, b));
      if (!r.error && r.data) arquivosPorUsuario = new Map(r.data.map(x => [String(x.user_id), x]));
    } catch (e) { /* função ainda não criada */ }
    const infoArq = (p) => arquivosPorUsuario ? (arquivosPorUsuario.get(String(p.id)) || { arquivos: 0, bytes: 0, ultimo_envio: null }) : { arquivos: (p.storage_usado || 0) > 0 ? null : 0, bytes: p.storage_usado || 0, ultimo_envio: null };
    const enviouArquivo = (p) => arquivosPorUsuario ? Number(infoArq(p).arquivos) > 0 : (p.storage_usado || 0) > 0;
    const pct1 = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    const pagoAtivo = (p) => { const ex = p.plano_expira_em ? Date.parse(p.plano_expira_em) : null; return PLANOS_PAGOS.includes(p.plano) && !(ex && ex < agora); };
    const emailDe = (id) => emailPorId.get(id) || '—';

    // Ativação: cadastrou e chegou a enviar pelo menos um arquivo (uso de armazenamento > 0)
    const ativados = perfis.filter(enviouArquivo).length;
    const coorte30 = perfis.filter(p => criadoPorId.get(p.id) && agora - criadoPorId.get(p.id) <= 30 * DIA_MS);
    const semArquivo = perfis
      .filter(p => !enviouArquivo(p) && criadoPorId.get(p.id) && agora - criadoPorId.get(p.id) >= DIA_MS)   // dá 1 dia de chance antes de cobrar
      .sort((a, b) => criadoPorId.get(b.id) - criadoPorId.get(a.id));
    const ativacao = {
      fonte: arquivosPorUsuario ? 'arquivos' : 'cota',
      cadastros: perfis.length, ativados, taxa: pct1(ativados, perfis.length),
      coorte30: { total: coorte30.length, ativados: coorte30.filter(enviouArquivo).length, taxa: pct1(coorte30.filter(enviouArquivo).length, coorte30.length) },
      nuncaEnviaram: {
        total: semArquivo.length,
        lista: semArquivo.slice(0, 50).map(p => ({ email: emailDe(p.id), plano: p.plano || 'free', criadoEm: new Date(criadoPorId.get(p.id)).toISOString(), dias: Math.floor((agora - criadoPorId.get(p.id)) / DIA_MS) })),
      },
      enviaram: perfis.filter(enviouArquivo).map(p => { const i = infoArq(p); return { email: emailDe(p.id), plano: p.plano || 'free', arquivos: i.arquivos == null ? null : Number(i.arquivos), bytes: Number(i.bytes) || 0, ultimoEnvio: i.ultimo_envio || null }; })
        .sort((a, b) => Date.parse(b.ultimoEnvio || 0) - Date.parse(a.ultimoEnvio || 0)).slice(0, 50),
    };

    // Black Friday: início = PROMO_CAMPANHA_INICIO (opcional) ou o cadastro mais antigo com o plano da campanha
    const perfisBF = perfis.filter(p => p.plano === 'free_blackfriday');
    let inicioBF = process.env.PROMO_CAMPANHA_INICIO ? Date.parse(process.env.PROMO_CAMPANHA_INICIO) : NaN;
    if (!inicioBF) { const ds = perfisBF.map(p => criadoPorId.get(p.id)).filter(Boolean); inicioBF = ds.length ? Math.min(...ds) : null; }
    let blackFriday = null;
    if (inicioBF) {
      const cadastrosBF = perfis.filter(p => (criadoPorId.get(p.id) || 0) >= inicioBF);
      const convertidos = cadastrosBF.filter(pagoAtivo);
      const ativa = campanhaAtiva();
      blackFriday = {
        ativa, inicioEm: new Date(inicioBF).toISOString(), fimEm: CAMPANHA_FIM.toISOString(),
        diasRestantes: ativa ? Math.max(0, Math.ceil((CAMPANHA_FIM.getTime() - agora) / DIA_MS)) : 0,
        cadastros: cadastrosBF.length,
        comPlano: perfisBF.length,
        ativaram: perfisBF.filter(enviouArquivo).length,
        usadoBytes: perfisBF.reduce((a, p) => a + (p.storage_usado || 0), 0),
        alocadoBytes: perfisBF.length * PLANOS.free_blackfriday,
        convertidos: convertidos.length,
        mrrConvertidos: Math.round(convertidos.reduce((a, p) => a + (PRECOS_MRR[p.plano] || 0), 0) * 100) / 100,
        taxaConversao: pct1(convertidos.length, cadastrosBF.length),
      };
    }

    // Promoções que vencem nos próximos 30 dias = oportunidade de venda
    const vencendo = perfis
      .filter(p => PLANOS_PROMO.includes(p.plano) && p.plano_expira_em && Date.parse(p.plano_expira_em) > agora && Date.parse(p.plano_expira_em) - agora <= 30 * DIA_MS)
      .sort((a, b) => Date.parse(a.plano_expira_em) - Date.parse(b.plano_expira_em));
    const promocoesVencendo = {
      total: vencendo.length,
      lista: vencendo.slice(0, 15).map(p => ({
        email: emailDe(p.id), plano: p.plano, expiraEm: p.plano_expira_em,
        dias: Math.ceil((Date.parse(p.plano_expira_em) - agora) / DIA_MS),
        percentual: Math.round(((p.storage_usado || 0) / (PLANOS[p.plano] || PLANOS.free)) * 100),
      })),
    };

    // Funil dos últimos 30 dias: cadastrou → enviou arquivo → pagou (visitantes vêm do /analytics/stats)
    const funil = {
      cadastros: coorte30.length,
      ativaram: coorte30.filter(enviouArquivo).length,
      pagaram: coorte30.filter(pagoAtivo).length,
    };

    // Histórico de receita: tabela pagamentos (pagamentos.sql). Sem ela, o card pede para criar.
    let receita = { tabelaPronta: false };
    try {
      const r = await buscarTudo((a, b) => db.from('pagamentos').select('mp_payment_id, user_id, valor, pago_em').order('pago_em').range(a, b));
      if (!r.error && r.data) {
        const chaveMes = (t) => new Date(Date.parse(t) - OFFSET_BR).toISOString().slice(0, 7);   // AAAA-MM (Brasília)
        const meses = [];
        const ref = new Date(Date.now() - OFFSET_BR);
        for (let k = 11; k >= 0; k--) meses.push(new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
        const porMes = Object.fromEntries(meses.map(m => [m, { mes: m, receita: 0, pagamentos: 0 }]));
        const porCliente = new Map();
        let total = 0, ult30 = 0, ant30 = 0;
        r.data.forEach(x => {
          const v = Number(x.valor) || 0, t = Date.parse(x.pago_em);
          total += v;
          const m = porMes[chaveMes(x.pago_em)];
          if (m) { m.receita += v; m.pagamentos++; }
          porCliente.set(x.user_id, (porCliente.get(x.user_id) || 0) + 1);
          if (agora - t <= 30 * DIA_MS) ult30 += v; else if (agora - t <= 60 * DIA_MS) ant30 += v;
        });
        const pagantesUnicos = porCliente.size, recorrentes = [...porCliente.values()].filter(n => n >= 2).length;
        const r2 = (n) => Math.round(n * 100) / 100;
        receita = {
          tabelaPronta: true, pagamentos: r.data.length, total: r2(total),
          ticketMedio: r.data.length ? r2(total / r.data.length) : 0,
          ultimos30dias: r2(ult30), anteriores30dias: r2(ant30),
          variacaoPercentual: ant30 > 0 ? Math.round(((ult30 - ant30) / ant30) * 100) : null,
          pagantesUnicos, recorrentes, taxaRenovacao: pct1(recorrentes, pagantesUnicos),
          conversaoGratuitoPago: pct1(perfis.filter(pagoAtivo).length, perfis.length),
          porMes: meses.map(m => ({ mes: m, receita: r2(porMes[m].receita), pagamentos: porMes[m].pagamentos })),
        };
      }
    } catch (e) { /* tabela ainda não criada */ }

    // ── Clientes por região ──
    // Só Brasil entra nos rankings (siglas como PA e AL também existem em outros países)
    const noBrasil = (p) => !p.pais || String(p.pais).toUpperCase() === 'BR';
    const comRegiaoTodas = perfis.filter(p => p.cidade || p.estado);
    const comRegiao = comRegiaoTodas.filter(noBrasil);
    const clientesPorRegiao = {
      comRegiao: comRegiao.length,
      foraDoBrasil: comRegiaoTodas.length - comRegiao.length,
      semRegiao: perfis.length - comRegiaoTodas.length,
      porEstado: rankingPor(comRegiao, p => p.estado, 30),
      porCidade: rankingPor(comRegiao, p => p.cidade ? (p.estado ? `${p.cidade} - ${p.estado}` : p.cidade) : null, 10),
    };

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      clientesPorRegiao,
      ativacao, blackFriday, promocoesVencendo, funil, historicoReceita: receita,
      proximosLimite: { total: candidatosUpgrade.length, lista: proximosLimite },
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

app.get('/api/campanhas', exigirAdminApi, async (req, res) => {
  const db = getDB();
  const { data, error } = await db.from('campanhas').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.post('/api/campanhas', exigirAdminApi, async (req, res) => {
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

app.patch('/api/campanhas/:id', exigirAdminApi, async (req, res) => {
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

app.delete('/api/campanhas/:id', exigirAdminApi, async (req, res) => {
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
- BLACK FRIDAY (tempo limitado): 15 GB grátis por 6 meses para quem criar conta, sem cartão de crédito. Depois que a campanha acabar, a promoção "Experimente" volta a ser de 2 GB grátis por 6 meses.
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
  const { visitor_id, pagina, referrer, utm_source } = req.body || {};
  if (!visitor_id || !pagina) return res.status(400).json({ erro: 'visitor_id e pagina obrigatorios' });
  if (visitaInvalida(req, visitor_id)) return res.json({ ok: true, ignorado: true });
  const db = getDB();
  const linha = { visitor_id, pagina: String(pagina).slice(0, 200), referrer: referrer ? String(referrer).slice(0, 300) : null };

  // Guarda navegador, região e origem (utm). Se alguma coluna ainda não existir, tenta com menos campos
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const utm = utm_source ? String(utm_source).slice(0, 40) : null;
  const tentativas = [
    { ...linha, user_agent: ua, ...regiaoDaRequisicao(req), origem: utm },
    { ...linha, user_agent: ua, ...regiaoDaRequisicao(req) },
    { ...linha, user_agent: ua },
    linha,
  ];
  for (const t of tentativas) {
    const { error } = await db.from('page_views').insert(t);
    if (!error) break;
  }
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
app.get('/api/analytics/stats', exigirAdminApi, async (req, res) => {
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
    const { data: visitantesHojeData } = await buscarTudo((a, b) => db.from('page_views').select('visitor_id').gte('created_at', inicioHoje).order('id').range(a, b));
    const visitantesUnicosHoje = new Set((visitantesHojeData || []).map(v => v.visitor_id)).size;

    // Paginas mais acessadas (ultimos 30 dias)
    const { data: paginasData } = await buscarTudo((a, b) => db.from('page_views').select('pagina').gte('created_at', trintaDiasAtras).order('id').range(a, b));
    const contagemPaginas = {};
    (paginasData || []).forEach(p => { contagemPaginas[p.pagina] = (contagemPaginas[p.pagina] || 0) + 1; });
    const paginasMaisAcessadas = Object.entries(contagemPaginas)
      .map(([pagina, visitas]) => ({ pagina, visitas }))
      .sort((a, b) => b.visitas - a.visitas)
      .slice(0, 8);

    // Visitas por dia (ultimos 14 dias, para o grafico)
    const catorzeDiasAtras = new Date(agora.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: visitasPorDiaData } = await buscarTudo((a, b) => db.from('page_views').select('created_at').gte('created_at', catorzeDiasAtras).order('id').range(a, b));
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

    // Visitantes únicos por cidade/estado (últimos 30 dias). Se as colunas não existem, vem vazio.
    let visitantesPorEstado = [], visitantesPorCidade = [];
    try {
      const { data: regData, error: regErro } = await buscarTudo((a, b) => db.from('page_views').select('visitor_id, cidade, estado, pais').gte('created_at', trintaDiasAtras).not('estado', 'is', null).order('id').range(a, b));
      if (!regErro && regData) {
        const vistos = new Map();
        regData.forEach(v => { if ((!v.pais || String(v.pais).toUpperCase() === 'BR') && !vistos.has(v.visitor_id)) vistos.set(v.visitor_id, v); });
        const unicos = [...vistos.values()];
        visitantesPorEstado = rankingPor(unicos, v => v.estado, 30);
        visitantesPorCidade = rankingPor(unicos, v => v.cidade ? `${v.cidade} - ${v.estado}` : null, 10);
      }
    } catch (e) { /* ignora */ }

    // Origem do tráfego: de onde veio cada visitante único (primeiro contato nos últimos 30 dias)
    let origemTrafego = [], visitantesUnicos30d = null, dispositivos = null;
    try {
      let colunas = 'visitor_id, referrer, origem, user_agent';
      let r = await buscarTudo((a, b) => db.from('page_views').select(colunas).gte('created_at', trintaDiasAtras).order('id').range(a, b));
      if (r.error) { colunas = 'visitor_id, referrer, origem'; r = await buscarTudo((a, b) => db.from('page_views').select(colunas).gte('created_at', trintaDiasAtras).order('id').range(a, b)); }
      if (r.error) { colunas = 'visitor_id, referrer'; r = await buscarTudo((a, b) => db.from('page_views').select(colunas).gte('created_at', trintaDiasAtras).order('id').range(a, b)); }
      if (!r.error && r.data) {
        const porVisitante = new Map();
        r.data.forEach(v => {
          const o = classificarOrigem(v.referrer, v.origem);
          const atual = porVisitante.get(v.visitor_id);
          if (!atual || (atual === 'Direto' && o !== 'Direto')) porVisitante.set(v.visitor_id, o);
        });
        origemTrafego = rankingPor([...porVisitante.values()], o => o, 10);
        visitantesUnicos30d = porVisitante.size;
        if (colunas.includes('user_agent')) {
          // um dispositivo por visitante (o primeiro user-agent humano visto); robôs ficam de fora
          const dispPorVisitante = new Map();
          r.data.forEach(v => { if (!dispPorVisitante.has(v.visitor_id)) { const d = classificarDispositivo(v.user_agent); if (d) dispPorVisitante.set(v.visitor_id, d); } });
          const lista = [...dispPorVisitante.values()];
          dispositivos = { total: lista.length, tipo: rankingPor(lista, d => d.tipo, 5), sistema: rankingPor(lista, d => d.sistema, 6), navegador: rankingPor(lista, d => d.navegador, 6) };
        }
      }
    } catch (e) { /* ignora */ }

    res.json({
      ok: true,
      visitantesPorEstado,
      visitantesPorCidade,
      origemTrafego,
      visitantesUnicos30d,
      dispositivos,
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
