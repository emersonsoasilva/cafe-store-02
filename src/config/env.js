// Carrega e valida as variáveis de ambiente uma única vez.
// Falhar rápido (fail fast) se segredos obrigatórios não existirem evita rodar
// o sistema em um estado inseguro (OWASP A05 - Security Misconfiguration).
const path = require('path');
require('dotenv').config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}. Rode "npm run build" para gerar o .env.`);
  }
  return value;
}

const env = {
  // Vazio = automático: tenta a porta 80 (padrão do navegador, então basta
  // digitar só o IP, ex.: http://10.81.211.26) e, se ela estiver ocupada ou
  // bloqueada, usa a 3000 (aí o endereço fica http://IP:3000).
  // Preenchido = usa exatamente essa porta.
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : null,
  fallbackPort: 3000,
  // 0.0.0.0 = aceita conexões de outras máquinas da rede (ex.: o professor
  // acessando http://IP-DA-SUA-MAQUINA:3000). Use 127.0.0.1 para só local.
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Endereço público usado para montar links (ex.: e-mail de reset de senha).
  // Vazio = detectado automaticamente a partir do IP da máquina na rede.
  // Não usamos o header Host da requisição para isso, porque ele é
  // controlado pelo cliente (evita "host header injection" no link de reset).
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // O front-end é servido pelo próprio servidor (mesma origem), então CORS
  // não é necessário. Só preencha se um front em OUTRA origem precisar da API.
  corsOrigin: process.env.CORS_ORIGIN || '',

  jwtSecret: required('JWT_SECRET'),
  fieldEncryptionKey: required('FIELD_ENCRYPTION_KEY'),

  // Só "true" quando o site estiver atrás de HTTPS. Em http://IP, cookies
  // "Secure" não são gravados pelo navegador e o login pararia de funcionar.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  httpsEnabled: process.env.HTTPS_ENABLED === 'true',

  // Só ative atrás de um proxy reverso (Nginx, Render...). Ativar sem proxy
  // deixaria o cliente forjar o IP via X-Forwarded-For e burlar o rate limit.
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : false,

  // --- Simulador de atividade (tela /simulator.html, só admin) ---
  // Duração de cada fase (uma atividade sorteada por fase) e intervalo entre
  // cada ação repetida dentro da fase. Também podem ser ajustados na tela.
  simulatorPhaseSeconds: parseInt(process.env.SIMULATOR_PHASE_SECONDS || '30', 10),
  simulatorIntervalSeconds: parseInt(process.env.SIMULATOR_ACTION_INTERVAL_SECONDS || '3', 10),

  // --- Banco NoSQL embutido (NeDB) ---
  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')),
};

if (env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET muito curto. Use pelo menos 32 caracteres aleatórios.');
}

if (!/^[0-9a-fA-F]{64}$/.test(env.fieldEncryptionKey)) {
  throw new Error('FIELD_ENCRYPTION_KEY deve ser uma string hex de 64 caracteres (32 bytes).');
}

if (!(env.simulatorPhaseSeconds >= 5 && env.simulatorPhaseSeconds <= 3600)) {
  throw new Error('SIMULATOR_PHASE_SECONDS deve ser um número entre 5 e 3600.');
}
if (!(env.simulatorIntervalSeconds >= 1 && env.simulatorIntervalSeconds <= 60)) {
  throw new Error('SIMULATOR_ACTION_INTERVAL_SECONDS deve ser um número entre 1 e 60.');
}

if (env.cookieSecure && !env.httpsEnabled) {
  console.warn('[aviso] COOKIE_SECURE=true sem HTTPS: o login não funcionará via http://IP.');
}

module.exports = env;
