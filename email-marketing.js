// ============================================================
// CloudX — E-mail marketing pelo Gmail (rotas do painel admin)
// Carregado pelo api/index.js:
//   require('../email-marketing')(app, { getDB, listarTodosUsuarios, tokenAdminValido });
//
// Variáveis de ambiente (Vercel):
//   ADMIN_TOKEN        senha do painel (obrigatória: sem ela as rotas ficam trancadas)
//   GMAIL_USER         endereço do Gmail que envia
//   GMAIL_APP_PASSWORD senha de app do Google (16 letras)
//   EMAIL_LIMITE_DIA   (opcional) teto diário, padrão 400 (Gmail grátis ≈ 500/dia)
//   EMAIL_REMETENTE_NOME (opcional) nome exibido, padrão "CloudX"
//   BACKEND_URL        (já existe) usado no link de descadastro
// ============================================================
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PLANOS_PAGOS = ['basico', 'essencial', 'plus', 'premium'];
const PUBLICOS = ['todos', 'ativos', 'inativos', 'gratuitos', 'pagos', 'contatos'];
const DIA_MS = 24 * 60 * 60 * 1000;
const OFFSET_BR = 3 * 60 * 60 * 1000;                       // Brasília = UTC-3
const LIMITE_DIA = Number(process.env.EMAIL_LIMITE_DIA) || 400;
// Contatos importados (lista pessoal) recebem menos por dia: protege a reputação da conta. Ajuste com EMAIL_LIMITE_CONTATOS_DIA.
const LIMITE_CONTATOS_DIA = Number(process.env.EMAIL_LIMITE_CONTATOS_DIA) || 30;
const POR_LOTE = 2;          // e-mails por chamada (a Vercel limita o tempo de cada chamada)
const PAUSA_MS = 600;        // pausa entre um e-mail e outro dentro do lote
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── Anexos ──
const ANEXO_TIPOS = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const MAX_ANEXOS = 3;
const MAX_ANEXOS_BYTES = 3 * 1024 * 1024;   // 3 MB no total: o arquivo viaja em base64 e a Vercel aceita no máximo 4,5 MB por requisição
const ASSINATURAS = {                        // primeiros bytes de cada formato (impede enviar outro tipo de arquivo renomeado)
  pdf: [0x25, 0x50, 0x44, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38], webp: [0x52, 0x49, 0x46, 0x46],
};

function validarAnexos(anexos) {
  if (anexos == null) return { lista: [] };
  if (!Array.isArray(anexos)) return { erro: 'Anexos em formato inválido.' };
  if (anexos.length > MAX_ANEXOS) return { erro: `No máximo ${MAX_ANEXOS} anexos por e-mail.` };
  let total = 0; const lista = [];
  for (const a of anexos) {
    const nome = String((a && a.nome) || '').replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(-100);
    const ext = nome.includes('.') ? nome.split('.').pop().toLowerCase() : '';
    if (!nome || !ANEXO_TIPOS[ext]) return { erro: `Tipo de arquivo não permitido: ${nome || '(sem nome)'}. Aceitos: ${Object.keys(ANEXO_TIPOS).join(', ')}.` };
    if (typeof a.dados !== 'string' || !/^[A-Za-z0-9+\/=\s]+$/.test(a.dados)) return { erro: `Arquivo inválido: ${nome}.` };
    const buffer = Buffer.from(a.dados, 'base64');
    if (!buffer.length) return { erro: `Arquivo vazio: ${nome}.` };
    total += buffer.length;
    const sig = ASSINATURAS[ext];
    if (sig && !sig.every((b, i) => buffer[i] === b)) return { erro: `O conteúdo de "${nome}" não parece ser um .${ext} de verdade.` };
    lista.push({ nome, tipo: ANEXO_TIPOS[ext], buffer, dados: buffer.toString('base64') });
  }
  if (total > MAX_ANEXOS_BYTES) return { erro: `Os anexos somam ${(total / 1048576).toFixed(1)} MB; o limite é ${MAX_ANEXOS_BYTES / 1048576} MB no total.` };
  return { lista };
}

const MSG_GMAIL = 'Gmail não configurado. Crie GMAIL_USER e GMAIL_APP_PASSWORD na Vercel e faça um Redeploy.';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function inicioHojeISO() {
  const d = new Date(Date.now() - OFFSET_BR);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + OFFSET_BR).toISOString();
}

// Limpa o que costuma vir errado ao colar na Vercel: espaços, quebra de linha e aspas
const limpar = (v) => String(v == null ? '' : v).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const gmailUser = () => limpar(process.env.GMAIL_USER).toLowerCase();
const gmailSenha = () => limpar(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '');
const gmailConfigurado = () => !!(gmailUser() && gmailSenha());
const criarTransporte = () => nodemailer.createTransport({
  service: 'gmail',
  auth: { user: gmailUser(), pass: gmailSenha() },
});
const remetente = () => `"${String(process.env.EMAIL_REMETENTE_NOME || 'CloudX').replace(/"/g, '')}" <${gmailUser()}>`;

// Mensagem de login recusado com o que ajuda a achar o erro (só o admin vê; a senha nunca é mostrada)
function descreverErroLogin(e) {
  const resposta = String((e && (e.response || e.message)) || '').replace(/\s+/g, ' ').slice(0, 180);
  const user = gmailUser(), senha = gmailSenha();
  let dica = '';
  if (senha.length !== 16) dica = ' A senha de app tem sempre 16 letras: a colada tem ' + senha.length + '. Gere outra e cole inteira.';
  else if (!/@(gmail|googlemail)\.com$/.test(user)) dica = ' O GMAIL_USER não parece um endereço @gmail.com.';
  else dica = ' Confira se a senha foi gerada NESSA mesma conta e se a verificação em duas etapas continua ligada.';
  return `O Gmail recusou o login. Usuário usado: ${user} · senha de app com ${senha.length} caracteres.${dica} (Resposta do Google: ${resposta})`;
}

// ── Link de descadastro (assinado: ninguém consegue descadastrar o e-mail dos outros) ──
const segredo = () => process.env.UNSUB_SECRET || process.env.ADMIN_TOKEN || '';
const assinar = (email) => crypto.createHmac('sha256', segredo()).update(String(email).toLowerCase()).digest('hex').slice(0, 32);
const baseUrl = () => (process.env.BACKEND_URL || 'https://cloudx-backend.vercel.app').replace(/\/+$/, '');
const linkDescadastro = (email) =>
  `${baseUrl()}/api/email/descadastrar?e=${Buffer.from(email).toString('base64url')}&t=${assinar(email)}`;

function verificarLink(e, t) {
  try {
    if (!segredo() || !e || !t) return null;
    const email = Buffer.from(String(e), 'base64url').toString('utf8').toLowerCase();
    const a = Buffer.from(assinar(email)), b = Buffer.from(String(t));
    if (!EMAIL_OK.test(email) || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return email;
  } catch (err) { return null; }
}

// ── Monta o e-mail (texto + HTML simples, sem pixel de rastreio) ──
function montarMensagem(assunto, corpo, nome, email, contato) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || 'cliente';
  const troca = (s) => String(s).replace(/\{\{\s*nome\s*\}\}/gi, primeiro);
  const texto = troca(corpo).replace(/\r\n/g, '\n').trim();
  const link = linkDescadastro(email);
  // Quem veio da lista pessoal NÃO tem conta no CloudX: o rodapé diz a verdade sobre por que recebeu
  const motivo = contato
    ? 'Você recebeu esta mensagem porque seu e-mail está na lista de contatos de quem criou o CloudX.'
    : 'Você recebeu este e-mail porque tem uma conta no CloudX.';

  const paragrafos = esc(texto).split(/\n{2,}/).map(p =>
    '<p style="margin:0 0 16px">' +
    p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb">$1</a>') +
    '</p>').join('');

  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px 12px;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px">
<tr><td style="padding:32px;font-size:15px;line-height:1.65">${paragrafos}</td></tr>
<tr><td style="padding:18px 32px 26px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280">
${esc(motivo)}<br>
<a href="${esc(link)}" style="color:#6b7280">Não quero receber mais e-mails</a>
</td></tr></table></td></tr></table></body></html>`;

  return {
    assunto: troca(assunto).replace(/[\r\n]+/g, ' ').trim(),
    texto: `${texto}\n\n--\n${motivo}\nPara não receber mais: ${link}\n`,
    html,
    link,
  };
}

async function enviarUm(transp, { email, nome, assunto, corpo, anexos, contato }) {
  const m = montarMensagem(assunto, corpo, nome, email, contato);
  await transp.sendMail({
    from: remetente(), to: email, subject: m.assunto, text: m.texto, html: m.html,
    headers: { 'List-Unsubscribe': `<${m.link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    attachments: (anexos || []).map(a => ({ filename: a.nome, content: a.buffer, contentType: a.tipo })),
  });
}

const erroLogin = (e) => !!e && (e.code === 'EAUTH' || e.responseCode === 535);
const erroCota = (e) => !!e && /quota|limit exceeded|5\.4\.5|4\.2\.1|too many/i.test(String(e.response || e.message || ''));

module.exports = function registrarEmailMarketing(app, { getDB, listarTodosUsuarios, tokenAdminValido }) {

  // ── Tudo aqui exige o ADMIN_TOKEN ──
  const exigirAdmin = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!process.env.ADMIN_TOKEN) return res.status(503).json({ ok: false, erro: 'ADMIN_TOKEN não configurada na Vercel.' });
    if (!tokenAdminValido(req)) return res.status(401).json({ ok: false, erro: 'Token de admin inválido.' });
    next();
  };

  // Quem pode receber: usuários cadastrados com e-mail válido, sem duplicados e SEM quem já se descadastrou
  async function carregarBase(db) {
    const [usuarios, perfisRes, descRes, contRes] = await Promise.all([
      listarTodosUsuarios(db),
      db.from('perfis').select('id, plano, plano_expira_em'),
      db.from('email_descadastros').select('email'),
      db.from('email_contatos').select('email, nome'),
    ]);
    if (perfisRes.error) throw perfisRes.error;
    if (descRes.error) {
      const e = new Error('Não consegui ler a lista de descadastros (' + descRes.error.message + '). Rode o arquivo email_marketing.sql no Supabase antes de usar.');
      e.pendente = true; throw e;
    }
    const agora = Date.now();
    const perfilPorId = new Map((perfisRes.data || []).map(p => [p.id, p]));
    const descad = new Set((descRes.data || []).map(d => String(d.email).toLowerCase()));
    const vistos = new Set(), pessoas = [];
    for (const u of usuarios) {
      const email = String(u.email || '').trim().toLowerCase();
      if (!EMAIL_OK.test(email) || vistos.has(email)) continue;
      vistos.add(email);
      if (descad.has(email)) continue;
      const p = perfilPorId.get(u.id) || {};
      const expira = p.plano_expira_em ? Date.parse(p.plano_expira_em) : null;
      const pago = PLANOS_PAGOS.includes(p.plano) && (!expira || expira > agora);
      const ultimo = u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : 0;
      const m = u.user_metadata || {};
      pessoas.push({ email, nome: String(m.nome || m.full_name || m.name || '').trim(), pago, ativo: !!ultimo && agora - ultimo <= 30 * DIA_MS });
    }
    // contatos importados: fora quem já é usuário, quem se descadastrou e duplicados
    const contatos = [];
    if (!contRes.error) for (const c of (contRes.data || [])) {
      const email = String(c.email || '').trim().toLowerCase();
      if (!EMAIL_OK.test(email) || vistos.has(email) || descad.has(email)) continue;
      vistos.add(email); contatos.push({ email, nome: String(c.nome || '').trim() });
    }
    return { pessoas, contatos, contatosOk: !contRes.error, descadastrados: descad.size };
  }
  const filtrar = (pessoas, publico) => pessoas.filter(p =>
    publico === 'todos' || (publico === 'ativos' && p.ativo) || (publico === 'inativos' && !p.ativo) ||
    (publico === 'pagos' && p.pago) || (publico === 'gratuitos' && !p.pago));
  const destinatarios = (base, publico) => publico === 'contatos' ? base.contatos : filtrar(base.pessoas, publico);

  async function contarEnviadosHoje(db) {
    const { count } = await db.from('email_envios').select('id', { count: 'exact', head: true })
      .eq('status', 'enviado').gte('enviado_em', inicioHojeISO());
    return count || 0;
  }
  async function contarEnviadosContatosHoje(db) {
    const { data: camps } = await db.from('email_campanhas').select('id').eq('publico', 'contatos');
    const ids = (camps || []).map(c => c.id);
    if (!ids.length) return 0;
    const { count } = await db.from('email_envios').select('id', { count: 'exact', head: true })
      .eq('status', 'enviado').in('campanha_id', ids).gte('enviado_em', inicioHojeISO());
    return count || 0;
  }
  async function totais(db, id) {
    const c = async (st) => (await db.from('email_envios').select('id', { count: 'exact', head: true }).eq('campanha_id', id).eq('status', st)).count || 0;
    const [enviados, falhas, pendentes, enviando] = await Promise.all([c('enviado'), c('falha'), c('pendente'), c('enviando')]);
    return { enviados, falhas, restantes: pendentes + enviando };
  }
  const validarTexto = (assunto, corpo) => {
    if (typeof assunto !== 'string' || assunto.trim().length < 3 || assunto.length > 150) return 'O assunto precisa ter de 3 a 150 caracteres.';
    if (typeof corpo !== 'string' || corpo.trim().length < 10 || corpo.length > 20000) return 'A mensagem precisa ter pelo menos 10 caracteres.';
    return null;
  };

  // ── Situação geral: Gmail, limite do dia, descadastros e tamanho de cada público ──
  app.get('/api/admin/email/status', exigirAdmin, async (req, res) => {
    try {
      const db = getDB();
      const base = await carregarBase(db);
      const publicos = {};
      PUBLICOS.forEach(p => { publicos[p] = destinatarios(base, p).length; });
      res.json({
        ok: true, gmailConfigurado: gmailConfigurado(), remetente: gmailUser() || null,
        limiteDia: LIMITE_DIA, limiteContatosDia: LIMITE_CONTATOS_DIA, enviadosHoje: await contarEnviadosHoje(db),
        descadastrados: base.descadastrados, publicos,
      });
    } catch (e) { res.status(e.pendente ? 409 : 500).json({ ok: false, erro: e.message, tabelasPendentes: !!e.pendente }); }
  });

  // ── Teste: manda a mensagem só para o próprio Gmail do CloudX ──
  app.post('/api/admin/email/teste', exigirAdmin, async (req, res) => {
    try {
      if (!gmailConfigurado()) return res.status(400).json({ ok: false, erro: MSG_GMAIL });
      const { assunto, corpo, anexos } = req.body || {};
      const problema = validarTexto(assunto, corpo);
      if (problema) return res.status(400).json({ ok: false, erro: problema });
      const va = validarAnexos(anexos);
      if (va.erro) return res.status(400).json({ ok: false, erro: va.erro });
      await enviarUm(criarTransporte(), { email: gmailUser(), nome: 'Teste', assunto: '[TESTE] ' + assunto, corpo, anexos: va.lista });
      res.json({ ok: true, para: gmailUser() });
    } catch (e) {
      res.status(erroLogin(e) ? 400 : 500).json({ ok: false, erro: erroLogin(e) ? descreverErroLogin(e) : 'Falha no envio: ' + (e.response || e.message) });
    }
  });

  // ── Prepara a campanha: grava a lista de destinatários (o envio acontece aos poucos, em /lote) ──
  app.post('/api/admin/email/preparar', exigirAdmin, async (req, res) => {
    try {
      if (!gmailConfigurado()) return res.status(400).json({ ok: false, erro: MSG_GMAIL });
      const { assunto, corpo, publico, anexos } = req.body || {};
      const problema = validarTexto(assunto, corpo);
      if (problema) return res.status(400).json({ ok: false, erro: problema });
      if (!PUBLICOS.includes(publico)) return res.status(400).json({ ok: false, erro: 'Público inválido.' });
      const va = validarAnexos(anexos);
      if (va.erro) return res.status(400).json({ ok: false, erro: va.erro });

      const db = getDB();
      const base = await carregarBase(db);
      if (publico === 'contatos' && !base.contatosOk) {
        const e = new Error('A tabela de contatos ainda não existe. Rode o arquivo email_contatos.sql no Supabase antes de usar.');
        e.pendente = true; throw e;
      }
      const lista = destinatarios(base, publico);
      if (!lista.length) return res.status(400).json({ ok: false, erro: 'Nenhum destinatário nesse público.' });

      const { data: camp, error } = await db.from('email_campanhas')
        .insert({ assunto: assunto.trim(), corpo, publico, total: lista.length, status: 'enviando' }).select().single();
      if (error) throw error;
      if (va.lista.length) {
        const { error: eA } = await db.from('email_anexos').insert(va.lista.map(a => (
          { campanha_id: camp.id, nome: a.nome, tipo: a.tipo, tamanho: a.buffer.length, dados: a.dados })));
        if (eA) {
          await db.from('email_campanhas').delete().eq('id', camp.id);
          const e = new Error('Não consegui guardar os anexos (' + eA.message + '). Rode o arquivo email_anexos.sql no Supabase antes de enviar com anexo.');
          e.pendente = true; throw e;
        }
      }
      for (let i = 0; i < lista.length; i += 500) {
        const { error: e2 } = await db.from('email_envios').insert(
          lista.slice(i, i + 500).map(p => ({ campanha_id: camp.id, email: p.email, nome: p.nome || null, status: 'pendente' })));
        if (e2) throw e2;
      }
      let sobra = LIMITE_DIA - await contarEnviadosHoje(db);
      if (publico === 'contatos') sobra = Math.min(sobra, LIMITE_CONTATOS_DIA - await contarEnviadosContatosHoje(db));
      res.json({
        ok: true, campanhaId: camp.id, total: lista.length, anexos: va.lista.length,
        aviso: lista.length > sobra ? `Hoje ainda dá para enviar ${Math.max(0, sobra)} e-mails (limite de ${publico === 'contatos' ? LIMITE_CONTATOS_DIA : LIMITE_DIA}/dia). O resto continua amanhã pelo histórico.` : null,
      });
    } catch (e) { res.status(e.pendente ? 409 : 500).json({ ok: false, erro: e.message, tabelasPendentes: !!e.pendente }); }
  });

  // ── Envia o próximo pedacinho (o painel chama de novo a cada poucos segundos) ──
  app.post('/api/admin/email/lote', exigirAdmin, async (req, res) => {
    try {
      if (!gmailConfigurado()) return res.status(400).json({ ok: false, erro: MSG_GMAIL });
      const id = Number(req.body && req.body.campanhaId);
      if (!id) return res.status(400).json({ ok: false, erro: 'campanhaId obrigatório.' });
      const db = getDB();
      const { data: camp, error } = await db.from('email_campanhas').select('*').eq('id', id).single();
      if (error || !camp) return res.status(404).json({ ok: false, erro: 'Campanha não encontrada.' });
      if (camp.status === 'cancelada') return res.json({ ok: false, erro: 'Esta campanha foi cancelada.' });

      const resposta = async (extra) => {
        const t = await totais(db, id);
        const concluida = t.restantes === 0;
        await db.from('email_campanhas').update({
          enviados: t.enviados, falhas: t.falhas,
          status: concluida ? 'concluida' : (extra.pausar ? 'pausada' : 'enviando'),
          concluido_em: concluida ? new Date().toISOString() : null,
        }).eq('id', id);
        if (concluida) await db.from('email_anexos').delete().eq('campanha_id', id);   // libera espaço no banco
        const { pausar, ...resto } = extra;
        return res.json({ ok: true, total: camp.total, ...t, concluida, ...resto });
      };

      // reservas antigas (falha no meio do caminho) voltam para a fila
      await db.from('email_envios').update({ status: 'pendente' })
        .eq('campanha_id', id).eq('status', 'enviando').lt('reservado_em', new Date(Date.now() - 3 * 60 * 1000).toISOString());

      const ehContato = camp.publico === 'contatos';
      let sobra = LIMITE_DIA - await contarEnviadosHoje(db), limiteAtual = LIMITE_DIA;
      if (ehContato) {
        const sobraC = LIMITE_CONTATOS_DIA - await contarEnviadosContatosHoje(db);
        if (sobraC < sobra) { sobra = sobraC; limiteAtual = LIMITE_CONTATOS_DIA; }
      }
      if (sobra <= 0) return resposta({ pausar: true, limiteDia: true, mensagem: `Limite diário de ${limiteAtual} e-mails${ehContato && limiteAtual === LIMITE_CONTATOS_DIA ? ' para contatos importados' : ''} atingido. Continue amanhã pelo histórico.` });

      // anexos da campanha (tabela inexistente = campanha sem anexos)
      const { data: linhasA, error: eA } = await db.from('email_anexos').select('nome, tipo, dados').eq('campanha_id', id);
      const semTabela = eA && (['42P01', 'PGRST205'].includes(eA.code) || /does not exist|could not find the table/i.test(eA.message || ''));
      if (eA && !semTabela) throw eA;
      const anexos = (linhasA || []).map(a => ({ nome: a.nome, tipo: a.tipo, buffer: Buffer.from(a.dados, 'base64') }));

      // com anexo cada e-mail é mais pesado: 1 por chamada, para não estourar o tempo da Vercel
      const { data: fila } = await db.from('email_envios').select('id, email, nome')
        .eq('campanha_id', id).eq('status', 'pendente').order('id').limit(Math.min(anexos.length ? 1 : POR_LOTE, sobra));
      if (!fila || !fila.length) return resposta({ enviadosLote: 0, falhasLote: 0 });

      // quem pediu descadastro depois de a campanha ser preparada não recebe
      const { data: sairam } = await db.from('email_descadastros').select('email').in('email', fila.map(f => f.email));
      const sairamSet = new Set((sairam || []).map(s => String(s.email).toLowerCase()));
      const idsSairam = fila.filter(f => sairamSet.has(f.email)).map(f => f.id);
      if (idsSairam.length) await db.from('email_envios').update({ status: 'descadastrado' }).in('id', idsSairam);
      const aEnviar = fila.filter(f => !sairamSet.has(f.email));
      if (!aEnviar.length) return resposta({ enviadosLote: 0, falhasLote: 0 });

      // reserva (impede que dois cliques enviem o mesmo e-mail duas vezes)
      const { data: reservados } = await db.from('email_envios')
        .update({ status: 'enviando', reservado_em: new Date().toISOString() })
        .in('id', aEnviar.map(f => f.id)).eq('status', 'pendente').select('id, email, nome');
      const lote = reservados || [];

      const transp = criarTransporte();
      let enviadosLote = 0, falhasLote = 0;
      for (let i = 0; i < lote.length; i++) {
        const dest = lote[i];
        try {
          await enviarUm(transp, { email: dest.email, nome: dest.nome, assunto: camp.assunto, corpo: camp.corpo, anexos, contato: ehContato });
          await db.from('email_envios').update({ status: 'enviado', enviado_em: new Date().toISOString(), erro: null }).eq('id', dest.id);
          enviadosLote++;
        } catch (e) {
          if (erroLogin(e) || erroCota(e)) {
            // problema da conta, não do destinatário: devolve este e os próximos para a fila e pausa
            await db.from('email_envios').update({ status: 'pendente' }).in('id', lote.slice(i).map(l => l.id));
            if (erroLogin(e)) {
              await db.from('email_campanhas').update({ status: 'pausada' }).eq('id', id);
              return res.json({ ok: false, erro: descreverErroLogin(e) });
            }
            return resposta({ pausar: true, limiteDia: true, enviadosLote, falhasLote, mensagem: 'O Gmail informou que o limite de envios foi atingido. Continue mais tarde pelo histórico.' });
          }
          await db.from('email_envios').update({ status: 'falha', erro: String(e.message || e).slice(0, 300) }).eq('id', dest.id);
          falhasLote++;
        }
        if (i < lote.length - 1) await dormir(PAUSA_MS);
      }
      return resposta({ enviadosLote, falhasLote });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── Contatos importados (CSV do Google Contatos): lista pessoal de quem o dono do CloudX conhece ──
  const SEM_RESPOSTA = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)@/i;
  app.post('/api/admin/email/contatos/importar', exigirAdmin, async (req, res) => {
    try {
      const { contatos, confirmou } = req.body || {};
      if (confirmou !== true) return res.status(400).json({ ok: false, erro: 'Marque a confirmação de que são pessoas que você conhece e que podem pedir para sair.' });
      if (!Array.isArray(contatos) || !contatos.length) return res.status(400).json({ ok: false, erro: 'Nenhum contato recebido.' });
      if (contatos.length > 500) return res.status(400).json({ ok: false, erro: 'Envie no máximo 500 contatos por vez.' });
      const db = getDB();
      const { data: desc, error: eD } = await db.from('email_descadastros').select('email');
      if (eD) { const e = new Error('Não consegui ler a lista de descadastros (' + eD.message + '). Rode o arquivo email_marketing.sql no Supabase.'); e.pendente = true; throw e; }
      const descad = new Set((desc || []).map(d => String(d.email).toLowerCase()));
      const vistos = new Set(), validos = [];
      let invalidos = 0, duplicados = 0, descadastrados = 0;
      for (const c of contatos) {
        const email = String((c && c.email) || '').trim().toLowerCase();
        if (!EMAIL_OK.test(email) || email.length > 200 || SEM_RESPOSTA.test(email) || email === gmailUser()) { invalidos++; continue; }
        if (vistos.has(email)) { duplicados++; continue; }
        vistos.add(email);
        if (descad.has(email)) { descadastrados++; continue; }
        validos.push({ email, nome: String((c && c.nome) || '').trim().slice(0, 100) || null, origem: 'csv' });
      }
      if (validos.length) {
        const { error } = await db.from('email_contatos').upsert(validos, { onConflict: 'email' });
        if (error) { const e = new Error('Não consegui guardar os contatos (' + error.message + '). Rode o arquivo email_contatos.sql no Supabase.'); e.pendente = true; throw e; }
      }
      res.json({ ok: true, importados: validos.length, invalidos, duplicados, descadastrados });
    } catch (e) { res.status(e.pendente ? 409 : 500).json({ ok: false, erro: e.message }); }
  });

  // Apaga TODA a lista importada (direito de exclusão: quem pedir para sair também some daqui pelo descadastro)
  app.post('/api/admin/email/contatos/limpar', exigirAdmin, async (req, res) => {
    try {
      const { error } = await getDB().from('email_contatos').delete().neq('email', '');
      if (error) throw error;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  app.post('/api/admin/email/cancelar', exigirAdmin, async (req, res) => {
    try {
      const id = Number(req.body && req.body.campanhaId);
      if (!id) return res.status(400).json({ ok: false, erro: 'campanhaId obrigatório.' });
      const db = getDB();
      const { error } = await db.from('email_campanhas').update({ status: 'cancelada' }).eq('id', id);
      if (error) throw error;
      await db.from('email_anexos').delete().eq('campanha_id', id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  app.get('/api/admin/email/campanhas', exigirAdmin, async (req, res) => {
    try {
      const { data, error } = await getDB().from('email_campanhas')
        .select('id, assunto, publico, total, enviados, falhas, status, criado_em, concluido_em')
        .order('id', { ascending: false }).limit(20);
      if (error) throw error;
      res.json({ ok: true, campanhas: data || [] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── Descadastro (público: é o link que vai dentro de cada e-mail) ──
  const pagina = (titulo, corpoHtml) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — CloudX</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a1220;font-family:Arial,Helvetica,sans-serif;color:#e8e8f0">
<div style="max-width:420px;margin:24px;padding:32px;background:#111c30;border:1px solid #1f2f4a;border-radius:14px;text-align:center">
<h1 style="font-size:20px;margin:0 0 12px">${esc(titulo)}</h1><div style="color:#9aa8c2;font-size:14px;line-height:1.6">${corpoHtml}</div></div></body></html>`;

  app.get('/api/email/descadastrar', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const email = verificarLink(req.query.e, req.query.t);
    if (!email) return res.status(400).send(pagina('Link inválido', 'Este link de descadastro não é válido.'));
    // confirmação por botão: evita que antivírus/leitores de e-mail descadastrem sozinhos ao "abrir" o link
    res.send(pagina('Cancelar inscrição',
      `Confirme para parar de receber e-mails do CloudX em <b style="color:#e8e8f0">${esc(email)}</b>.
       <form method="post" action="${esc(req.originalUrl)}" style="margin-top:20px">
       <button style="background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:11px 20px;font-size:14px;font-weight:600;cursor:pointer">Sim, cancelar inscrição</button></form>`));
  });

  app.post('/api/email/descadastrar', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const email = verificarLink(req.query.e, req.query.t);
    if (!email) return res.status(400).send(pagina('Link inválido', 'Este link de descadastro não é válido.'));
    const { error } = await getDB().from('email_descadastros').upsert({ email });
    if (error) return res.status(500).send(pagina('Algo deu errado', 'Não foi possível concluir agora. Tente novamente em instantes.'));
    res.send(pagina('Pronto!', 'Você não receberá mais e-mails de marketing do CloudX.'));
  });
};
