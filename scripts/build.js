/**
 * Build do projeto (npm run build). Sem dependências externas.
 *  1. Confere a versão do Node.
 *  2. Gera o .env com segredos ALEATÓRIOS se ele ainda não existir
 *     (nunca deixa segredo fixo/fraco no projeto — OWASP A02/A05).
 *  3. Checa a sintaxe de todos os arquivos .js.
 *  4. Gera a pasta dist/ com o que vai para execução (server.js, src/, public/).
 * Depois: npm start  (roda a partir de dist/).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error(`Node ${process.versions.node} é antigo demais. Use Node 18 ou superior.`);
  process.exit(1);
}

const envFile = path.join(root, '.env');
if (!fs.existsSync(envFile)) {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const content = template
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${crypto.randomBytes(64).toString('hex')}`)
    .replace(/^FIELD_ENCRYPTION_KEY=.*$/m, `FIELD_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(envFile, content);
  console.log('• .env criado com segredos aleatórios.');
} else {
  console.log('• .env existente mantido.');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [path.join(root, 'server.js'), ...walk(path.join(root, 'src')), ...walk(path.join(root, 'public'))];
let failed = false;
for (const file of files) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (err) {
    failed = true;
    console.error(`✗ Erro de sintaxe em ${path.relative(root, file)}: ${err.message}`);
  }
}
if (failed) process.exit(1);
console.log(`• Sintaxe ok em ${files.length} arquivos.`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
fs.copyFileSync(path.join(root, 'server.js'), path.join(dist, 'server.js'));
fs.cpSync(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(dist, 'public'), { recursive: true });
console.log('• Build gerado em dist/. Rode: npm start');
