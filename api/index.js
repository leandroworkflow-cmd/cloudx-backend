const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');
const mp      = require('../mercadopago');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const getDB = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── PLANOS E LIMITES (em bytes) ──
const PLANOS = {
  free:           1   * 1024 * 1024 * 1024,   // 1 GB (padrão, após expirar a promo)
  free_fundador:  2   * 1024 * 1024 * 1024,   // 2 GB — promo "Experimente", válida por 6 meses, sem limite de vagas
  basico:         30  * 1024 * 1024 * 1024,   // 30 GB
  essencial:      100 * 1024 * 1024 * 1024,   // 100 GB
  plus:           300 * 1024 * 1024 * 1024,   // 300 GB
  premium:        1024 * 1024 * 1024 * 1024,  // 1 TB
};

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
  if (perfil.plano === 'free_fundador' && perfil.plano_expira_em && new Date(perfil.plano_expira_em) < new Date()) {
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

  const expira = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000).toISOString(); // 6 meses
  const { error } = await req.db.from('perfis').update({
    plano: 'free_fundador',
    plano_expira_em: expira,
  }).eq('id', req.user.id);

  if (error) return res.status(500).json({ erro: error.message });
  res.json({ aplicado: true, plano: 'free_fundador', expira_em: expira });
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
    const porPlano = { free: 0, free_fundador: 0, basico: 0, essencial: 0, plus: 0, premium: 0 };
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
- Free Fundador: R$ 0, 2 GB grátis por 6 meses (promoção "Experimente", sem limite de vagas)
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

// Registra uma visualizacao de pagina + marca o visitante como online
app.post('/api/analytics/pageview', async (req, res) => {
  const { visitor_id, pagina, referrer } = req.body;
  if (!visitor_id || !pagina) return res.status(400).json({ erro: 'visitor_id e pagina obrigatorios' });
  const db = getDB();

  await db.from('page_views').insert({ visitor_id, pagina, referrer: referrer || null });
  await db.from('visitantes_online').upsert({ visitor_id, pagina, updated_at: new Date().toISOString() });

  res.json({ ok: true });
});

// Heartbeat: o site chama isso a cada ~20s enquanto a aba estiver aberta, pra manter o "online" atualizado
app.post('/api/analytics/heartbeat', async (req, res) => {
  const { visitor_id, pagina } = req.body;
  if (!visitor_id) return res.status(400).json({ erro: 'visitor_id obrigatorio' });
  const db = getDB();

  await db.from('visitantes_online').upsert({ visitor_id, pagina: pagina || null, updated_at: new Date().toISOString() });
  res.json({ ok: true });
});

// Estatisticas para o dashboard
app.get('/api/analytics/stats', async (req, res) => {
  try {
    const db = getDB();
    const agora = new Date();
    const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).toISOString();
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
      const dia = v.created_at.slice(0, 10); // YYYY-MM-DD
      contagemPorDia[dia] = (contagemPorDia[dia] || 0) + 1;
    });
    // Preenche os 14 dias mesmo os que tiveram 0 visitas, para o grafico ficar completo
    const visitasPorDia = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(agora.getTime() - i * 24 * 60 * 60 * 1000);
      const chave = d.toISOString().slice(0, 10);
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
