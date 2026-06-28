const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');
const mp      = require('../mercadopago');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors({ origin: '*' }));
app.use(express.json());

const getDB = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── PLANOS E LIMITES (em bytes) ──
const PLANOS = {
  free:           1   * 1024 * 1024 * 1024,   // 1 GB (padrão, após 200 vagas ou expirar promo)
  free_fundador:  10  * 1024 * 1024 * 1024,   // 10 GB — promo dos 200 primeiros, válida 1 ano
  basico:         30  * 1024 * 1024 * 1024,   // 30 GB
  essencial:      100 * 1024 * 1024 * 1024,   // 100 GB
  plus:           300 * 1024 * 1024 * 1024,   // 300 GB
  premium:        1024 * 1024 * 1024 * 1024,  // 1 TB
};

const LIMITE_VAGAS_FUNDADOR = 200;

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

// ── Chamado uma vez no cadastro (signup) para tentar aplicar a promo dos 200 primeiros ──
app.post('/api/promo/fundador', auth, async (req, res) => {
  const { data: perfil } = await req.db.from('perfis').select('id, plano').eq('id', req.user.id).single();
  if (!perfil) return res.status(404).json({ erro: 'Perfil não encontrado' });

  // Já tem algum plano definido (não é o primeiro contato) — não reaplica
  if (perfil.plano && perfil.plano !== 'free') {
    return res.json({ aplicado: false, motivo: 'Perfil já possui um plano' });
  }

  const { count } = await req.db.from('perfis').select('id', { count: 'exact', head: true }).eq('plano', 'free_fundador');

  if ((count || 0) >= LIMITE_VAGAS_FUNDADOR) {
    return res.json({ aplicado: false, motivo: 'Promoção esgotada', vagas_restantes: 0 });
  }

  const expira = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await req.db.from('perfis').update({
    plano: 'free_fundador',
    plano_expira_em: expira,
  }).eq('id', req.user.id);

  if (error) return res.status(500).json({ erro: error.message });
  res.json({ aplicado: true, plano: 'free_fundador', expira_em: expira, vagas_restantes: LIMITE_VAGAS_FUNDADOR - (count || 0) - 1 });
});

// ── Consulta pública: quantas vagas da promo ainda restam (pra mostrar no site) ──
app.get('/api/promo/fundador/vagas', async (req, res) => {
  const db = getDB();
  const { count } = await db.from('perfis').select('id', { count: 'exact', head: true }).eq('plano', 'free_fundador');
  res.json({ vagas_restantes: Math.max(LIMITE_VAGAS_FUNDADOR - (count || 0), 0), total: LIMITE_VAGAS_FUNDADOR });
});

app.get('/api/arquivos', auth, async (req, res) => {
  const pasta = req.query.pasta || '';
  const caminho = `${req.user.id}${pasta ? '/' + pasta : ''}`;
  const { data, error } = await req.db.storage.from('arquivos').list(caminho, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.post('/api/arquivos/upload', auth, upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });

  // Verifica cota antes de subir o arquivo
  const { data: perfil } = await req.db.from('perfis').select('plano, storage_usado, plano_expira_em, id').eq('id', req.user.id).single();
  if (perfil) {
    const perfilAtualizado = await resolverPlanoAtual(req.db, perfil);
    const limite = PLANOS[perfilAtualizado.plano] || PLANOS.free;
    if (perfilAtualizado.storage_usado + req.file.size > limite) {
      return res.status(403).json({ erro: 'Cota excedida', plano: perfilAtualizado.plano });
    }
  }

  const pasta = req.body.pasta || '';
  const caminho = `${req.user.id}${pasta ? '/' + pasta : ''}/${req.file.originalname}`;
  const { error } = await req.db.storage.from('arquivos').upload(caminho, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (error) return res.status(500).json({ erro: error.message });
  await req.db.rpc('incrementar_storage', { uid: req.user.id, bytes: req.file.size });
  res.json({ ok: true, caminho, tamanho: req.file.size });
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
