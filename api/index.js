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

const PLANOS = {
  free:      1  * 1024 * 1024 * 1024,
  basico:   50  * 1024 * 1024 * 1024,
  pro:      200 * 1024 * 1024 * 1024,
  business: 1024 * 1024 * 1024 * 1024,
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

app.get('/api/perfil', auth, async (req, res) => {
  const { data, error } = await req.db.from('perfis').select('*').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ erro: error.message });
  const limite = PLANOS[data.plano] || PLANOS.free;
  res.json({ ...data, limite, percentual: Math.round((data.storage_usado / limite) * 100) });
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
    basico:   { valor: 9.90,  nome: 'Plano Básico — 50 GB'  },
    pro:      { valor: 19.90, nome: 'Plano Pro — 200 GB'    },
    business: { valor: 49.90, nome: 'Plano Business — 1 TB' },
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

// Serve arquivos estáticos (manifest, sw, ícones)
app.use(require("express").static(root));

app.get("/", (req, res) => { res.sendFile(path.join(root, "index.html")); });
app.get("/sucesso", (req, res) => { res.sendFile(require("path").join(__dirname, "../sucesso.html")); });
app.get("/erro", (req, res) => { res.send('<html><body style="font-family:sans-serif;text-align:center;padding:80px"><h1>❌ Pagamento não concluído</h1><p>Tente novamente.</p><a href="/">← Voltar</a></body></html>'); });
app.get("/pendente", (req, res) => { res.send('<html><body style="font-family:sans-serif;text-align:center;padding:80px"><h1>⏳ Pagamento pendente</h1><p>Aguardando confirmação. Seu plano será ativado em breve.</p><a href="/">← Voltar</a></body></html>'); });

module.exports = app;
