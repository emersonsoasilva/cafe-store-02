const os = require('os');
const env = require('../config/env');

/** IPv4 desta máquina nas redes locais (ex.: 192.168.0.15, 10.0.3.27). */
function lanAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

/**
 * Endereço base usado em links gerados pelo servidor (ex.: e-mail de reset).
 * Prioridade: PUBLIC_URL do .env -> primeiro IP da rede -> localhost.
 */
function publicBaseUrl() {
  if (env.publicUrl) return env.publicUrl;
  const protocol = env.httpsEnabled ? 'https' : 'http';
  const ip = lanAddresses()[0] || 'localhost';
  return `${protocol}://${ip}${portSuffix(env.port)}`;
}

/** Porta padrão do protocolo (80 no http, 443 no https) não precisa aparecer na URL. */
function portSuffix(port) {
  const defaultPort = env.httpsEnabled ? 443 : 80;
  return port === defaultPort ? '' : `:${port}`;
}

module.exports = { lanAddresses, publicBaseUrl, portSuffix };
