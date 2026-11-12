const https = require('https');

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

function requisicao(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.mercadopago.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': Date.now().toString(),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Resposta inválida do MP')); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function criarPreferencia(dados) {
  const resultado = await requisicao('POST', '/checkout/preferences', dados);
  if (resultado.error) throw new Error(resultado.message || resultado.error);
  return resultado;
}

async function buscarPagamento(id) {
  const resultado = await requisicao('GET', `/v1/payments/${id}`);
  if (resultado.error) throw new Error(resultado.message || resultado.error);
  return resultado;
}

// Lista pagamentos aprovados da conta (mais recentes primeiro), para importar o histórico
async function listarPagamentos(offset = 0, limit = 50) {
  const qs = `sort=date_created&criteria=desc&status=approved&limit=${Number(limit) || 50}&offset=${Number(offset) || 0}`;
  const resultado = await requisicao('GET', `/v1/payments/search?${qs}`);
  if (resultado.error || resultado.status === 401) throw new Error(resultado.message || resultado.error || 'Mercado Pago recusou a consulta');
  return resultado;
}

module.exports = { criarPreferencia, buscarPagamento, listarPagamentos };
