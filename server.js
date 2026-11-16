const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const env = require('./src/config/env');
const { initDatabase } = require('./src/config/db');
const { lanAddresses, portSuffix } = require('./src/utils/network');

const { generalApiLimiter } = require('./src/middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const authRoutes = require('./src/routes/authRoutes');
const productRoutes = require('./src/routes/productRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const automationRoutes = require('./src/routes/automationRoutes');

const app = express();

// Só confia em X-Forwarded-For quando há um proxy reverso de verdade
// (TRUST_PROXY=true). Acessando direto pelo IP, confiar nesse header deixaria
// qualquer cliente forjar o próprio IP e escapar do rate limiting.
app.set('trust proxy', env.trustProxy);

// --- Cabeçalhos de segurança (OWASP A05 - Security Misconfiguration) ---
//
// CORREÇÃO DO "SITE SEM ESTILO QUANDO ACESSADO PELO IP":
// por padrão o helmet adiciona a diretiva CSP "upgrade-insecure-requests".
// Ela manda o navegador trocar http:// por https:// em TODOS os recursos da
// página (CSS, JS, imagens). Em http://localhost o navegador abre exceção,
// por isso funcionava na sua máquina; mas em http://192.168.x.x:3000 ele
// tenta buscar https://192.168.x.x:3000/css/style.css, que não existe (o
// servidor só fala HTTP) — o HTML carrega, mas sem CSS e sem JavaScript.
// Solução: só ativar essa diretiva (e o HSTS) quando o site rodar em HTTPS.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: env.httpsEnabled ? [] : null,
      },
    },
    strictTransportSecurity: env.httpsEnabled,
    // Estes dois cabeçalhos só têm efeito em HTTPS; em http://IP o navegador
    // os ignora e enche o console de avisos, então só são enviados com HTTPS.
    crossOriginOpenerPolicy: env.httpsEnabled,
    originAgentCluster: env.httpsEnabled,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
);
// Remove o header "X-Powered-By: Express" (evita divulgar a stack tecnológica).
app.disable('x-powered-by');

// --- CORS ---
// O front é servido por este mesmo servidor (mesma origem), então nenhuma
// origem externa é liberada por padrão. Isso também elimina o problema de um
// CORS_ORIGIN fixo em "localhost" quebrar o acesso via IP.
if (env.corsOrigin) {
  app.use(
    cors({
      origin: env.corsOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    })
  );
}

app.use(cookieParser());
// Limite de tamanho do corpo da requisição: mitiga ataques de negação de
// serviço por payloads gigantes.
app.use(express.json({ limit: '100kb' }));

app.use('/api', generalApiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api', productRoutes);
app.use('/api', orderRoutes);
app.use('/api', automationRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Front-end estático. Caminho absoluto a partir deste arquivo: funciona não
// importa de qual pasta o "npm start" for executado.
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use('/api', notFoundHandler);
app.use(errorHandler);

/** Tenta ouvir numa porta; resolve com o servidor ou rejeita com o erro (porta ocupada/bloqueada). */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, env.host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function explainPortError(err, port) {
  if (err.code === 'EADDRINUSE') return `a porta ${port} já está em uso por outro programa`;
  if (err.code === 'EACCES') return `sem permissão para usar a porta ${port}`;
  return err.message;
}

async function start() {
  try {
    await initDatabase();
  } catch (err) {
    console.error('[startup-error] Falha ao inicializar o banco de dados:', err.message);
    process.exit(1);
  }

  // PORT no .env = porta fixa. Sem PORT = tenta 80 (acesso só pelo IP) e cai para 3000.
  const candidates = env.port ? [env.port] : [80, env.fallbackPort];
  for (const port of candidates) {
    try {
      await listenOn(port);
      env.port = port; // porta real, usada também nos links gerados (reset de senha)
      const suffix = portSuffix(port);
      console.log('\n☕ Cafe Store rodando (banco NoSQL em ' + env.dataDir + ')');
      console.log(`   Nesta máquina:        http://localhost${suffix}`);
      for (const ip of lanAddresses()) {
        console.log(`   Na rede (professor):  http://${ip}${suffix}`);
      }
      if (suffix) {
        console.log(`\n   Atenção: está na porta ${port}, então o endereço PRECISA terminar com "${suffix}".`);
      }
      console.log('');
      return;
    } catch (err) {
      const reason = explainPortError(err, port);
      const next = candidates[candidates.indexOf(port) + 1];
      if (next) {
        console.warn(`[aviso] Não foi possível usar a porta ${port} (${reason}). Tentando a porta ${next}...`);
      } else {
        console.error(`[startup-error] Não foi possível iniciar: ${reason}. Feche o outro programa ou defina outra PORT no .env.`);
        process.exit(1);
      }
    }
  }
}

start();
