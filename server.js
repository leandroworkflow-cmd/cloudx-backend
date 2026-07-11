const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');
const mp      = require('./mercadopago');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

const db = createClient(
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
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ erro: 'Token inválido' });
  req.user = data.user;
  next();
}

async function verificarCota(req, res, next) {
  const { data: perfil } = await db.from('perfis').select('plano, storage_usado').eq('id', req.user.id).single();
  if (!perfil) return res.status(404).json({ erro: 'Perfil não encontrado' });
  const limite = PLANOS[perfil.plano] || PLANOS.free;
  const tamanho = parseInt(req.headers['content-length'] || 0);
  if (perfil.storage_usado + tamanho > limite) {
    return res.status(403).json({ erro: 'Cota excedida', plano: perfil.plano });
  }
  req.perfil = perfil;
  next();
}

app.get('/arquivos', auth, async (req, res) => {
  const pasta = req.query.pasta || '';
  const caminho = `${req.user.id}/${pasta}`;
  const { data, error } = await db.storage.from('arquivos').list(caminho, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.post('/arquivos/upload', auth, verificarCota, upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  const pasta = req.body.pasta || '';
  const caminho = `${req.user.id}/${pasta}/${req.file.originalname}`.replace('//', '/');
  const { error } = await db.storage.from('arquivos').upload(caminho, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (error) return res.status(500).json({ erro: error.message });
  await db.rpc('incrementar_storage', { uid: req.user.id, bytes: req.file.size });
  res.json({ ok: true, caminho, tamanho: req.file.size });
});

app.get('/arquivos/download', auth, async (req, res) => {
  const { caminho } = req.query;
  if (!caminho) return res.status(400).json({ erro: 'Caminho obrigatório' });
  if (!caminho.startsWith(req.user.id)) return res.status(403).json({ erro: 'Acesso negado' });
  const { data, error } = await db.storage.from('arquivos').createSignedUrl(caminho, 3600);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ url: data.signedUrl });
});

app.delete('/arquivos', auth, async (req, res) => {
  const { caminho } = req.body;
  if (!caminho) return res.status(400).json({ erro: 'Caminho obrigatório' });
  if (!caminho.startsWith(req.user.id)) return res.status(403).json({ erro: 'Acesso negado' });
  const { error } = await db.storage.from('arquivos').remove([caminho]);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

app.post('/pastas', auth, async (req, res) => {
  const { nome, pasta_pai } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const caminho = `${req.user.id}/${pasta_pai ? pasta_pai + '/' : ''}${nome}/.keep`;
  const { error } = await db.storage.from('arquivos').upload(caminho, Buffer.from(''), { contentType: 'text/plain', upsert: true });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

app.get('/perfil', auth, async (req, res) => {
  const { data, error } = await db.from('perfis').select('*').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ erro: error.message });
  const limite = PLANOS[data.plano] || PLANOS.free;
  res.json({ ...data, limite, percentual: Math.round((data.storage_usado / limite) * 100) });
});

const PRECOS = {
  basico:   { valor: 9.90,  nome: 'Plano Básico — 50 GB'  },
  pro:      { valor: 19.90, nome: 'Plano Pro — 200 GB'    },
  business: { valor: 49.90, nome: 'Plano Business — 1 TB' },
};

app.post('/pagamento/criar', auth, async (req, res) => {
  const { plano } = req.body;
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
      notification_url: `${process.env.BACKEND_URL}/webhook/mp`,
    });
    res.json({ url: preference.init_point });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/webhook/mp', async (req, res) => {
  const { type, data } = req.body;
  if (type !== 'payment') return res.sendStatus(200);
  try {
    const pagamento = await mp.buscarPagamento(data.id);
    if (pagamento.status !== 'approved') return res.sendStatus(200);
    const [userId, plano] = (pagamento.external_reference || '').split('|');
    if (!userId || !plano) return res.sendStatus(200);
    await db.from('perfis').update({
      plano,
      plano_expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq('id', userId);
    console.log(`✅ Plano ${plano} ativado para ${userId}`);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook erro:', e.message);
    res.sendStatus(500);
  }
});app.get('/dashboard/stats', async (req, res) => {
  try {
    // Busca todos os perfis (usuários) da tabela
    const { data: perfis, error } = await db.from('perfis').select('plano, storage_usado');

    if (error) return res.status(500).json({ erro: error.message });

    const totalUsuarios = perfis.length;

    // Conta quantos usuários existem em cada plano
    const porPlano = { free: 0, basico: 0, pro: 0, business: 0 };
    let storageTotalUsado = 0;

    perfis.forEach(p => {
      const plano = p.plano || 'free';
      if (porPlano[plano] !== undefined) porPlano[plano]++;
      storageTotalUsado += p.storage_usado || 0;
    });

    // Receita mensal estimada com base nos preços definidos no PRECOS
    const receitaMensal =
      (porPlano.basico * PRECOS.basico.valor) +
      (porPlano.pro * PRECOS.pro.valor) +
      (porPlano.business * PRECOS.business.valor);

    res.json({
      ok: true,
      atualizadoEm: new Date().toISOString(),
      totalUsuarios,
      porPlano,
      storageTotalUsadoGB: (storageTotalUsado / (1024 ** 3)).toFixed(2),
      receitaMensalEstimada: receitaMensal.toFixed(2),
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 CloudX backend rodando na porta ${PORT}`));

app.get('/dashboard/stats', async (req, res) => {
  try {
    const { data: perfis, error } = await db.from('perfis').select('plano, storage_usado');
    if (error) return res.status(500).json({ erro: error.message });

    const totalUsuarios = perfis.length;
    const porPlano = { free: 0, basico: 0, pro: 0, business: 0 };
    let storageTotalUsado = 0;

    perfis.forEach(p => {
      const plano = p.plano || 'free';
      if (porPlano[plano] !== undefined) porPlano[plano]++;
      storageTotalUsado += p.storage_usado || 0;
    });

    const receitaMensal =
      (porPlano.basico * PRECOS.basico.valor) +
      (porPlano.pro * PRECOS.pro.valor) +
      (porPlano.business * PRECOS.business.valor);

    res.json({
      ok: true,
      atualizadoEm: new Date().toISOString(),
      totalUsuarios,
      porPlano,
      storageTotalUsadoGB: (storageTotalUsado / (1024 ** 3)).toFixed(2),
      receitaMensalEstimada: receitaMensal.toFixed(2),
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});
