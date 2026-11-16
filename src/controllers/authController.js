const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db, withTransaction } = require('../config/db');
const env = require('../config/env');
const { generateOpaqueToken, hashToken } = require('../utils/crypto');
const { sendPasswordResetEmail } = require('../utils/mailer');
const { publicBaseUrl } = require('../utils/network');
const { createCustomer } = require('../services/userService');
const { auditLog } = require('../utils/logger');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;
const ACCESS_TOKEN_TTL = '30m';
const RESET_TOKEN_TTL_MINUTES = 15;

function toPublicUser(user) {
  return {
    id: user.public_id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    address: {
      street: user.address_street,
      city: user.address_city,
      state: user.address_state,
      zip: user.address_zip,
    },
  };
}

function setAuthCookies(res, user) {
  const accessToken = jwt.sign({ sub: user._id, role: user.role }, env.jwtSecret, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
  // csrf_token: legível por JS de propósito (double-submit cookie pattern).
  const csrfToken = crypto.randomBytes(24).toString('hex');

  const commonOpts = {
    secure: env.cookieSecure, // true em produção atrás de HTTPS
    sameSite: 'lax',
    path: '/',
  };

  res.cookie('access_token', accessToken, { ...commonOpts, httpOnly: true, maxAge: 30 * 60 * 1000 });
  res.cookie('csrf_token', csrfToken, { ...commonOpts, httpOnly: false, maxAge: 30 * 60 * 1000 });
  return { accessToken, csrfToken };
}

function clearAuthCookies(res) {
  res.clearCookie('access_token');
  res.clearCookie('csrf_token');
}

/** POST /api/auth/register */
async function register(req, res) {
  const { name, email, password, cpf, phone, street, city, state, zip } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  // String(...) em todo valor vindo do cliente: impede injeção de operadores
  // NoSQL (ex.: {"$ne": null} no lugar de um e-mail) — OWASP A03 Injection.
  const existing = await db.users.findOneAsync({ email: String(normalizedEmail) });
  if (existing) {
    // Mensagem propositalmente genérica: evita confirmar a um atacante que
    // aquele e-mail já está cadastrado (mitiga enumeração de usuários).
    return res.status(409).json({ error: 'Não foi possível concluir o cadastro com os dados informados.' });
  }

  let user;
  try {
    user = await createCustomer({ name, email: normalizedEmail, password, cpf, phone, street, city, state, zip });
  } catch (err) {
    // Índice único de e-mail: cobre a corrida de dois cadastros simultâneos.
    if (err.errorType === 'uniqueViolated') {
      return res.status(409).json({ error: 'Não foi possível concluir o cadastro com os dados informados.' });
    }
    throw err;
  }

  auditLog('user_registered', { userId: user._id, ip: req.ip });

  setAuthCookies(res, user);
  return res.status(201).json({ user: toPublicUser(user) });
}

/** POST /api/auth/login */
async function login(req, res) {
  const { email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.users.findOneAsync({ email: String(normalizedEmail) });

  const genericError = () => res.status(401).json({ error: 'E-mail ou senha inválidos.' });

  if (!user) {
    // Ainda assim fazemos um hash "fantasma" para que o tempo de resposta seja
    // parecido ao de um login com usuário existente, dificultando a
    // enumeração de contas por análise de tempo (timing attack).
    bcrypt.hashSync('senha-invalida-de-referencia', 12);
    auditLog('login_failed_unknown_email', { ip: req.ip });
    return genericError();
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    auditLog('login_blocked_account_locked', { userId: user._id, ip: req.ip });
    return res.status(423).json({
      error: `Conta temporariamente bloqueada por excesso de tentativas. Tente novamente após ${new Date(
        user.locked_until
      ).toISOString()}.`,
    });
  }

  const passwordOk = bcrypt.compareSync(password, user.password_hash);
  if (!passwordOk) {
    const attempts = user.failed_login_attempts + 1;
    let lockedUntil = null;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000);
    }
    await db.users.updateAsync(
      { _id: user._id },
      { $set: { failed_login_attempts: attempts, locked_until: lockedUntil } }
    );
    auditLog('login_failed_bad_password', { userId: user._id, ip: req.ip, details: { attempts } });
    return genericError();
  }

  // Login bem-sucedido: zera contador de tentativas e bloqueio.
  await db.users.updateAsync({ _id: user._id }, { $set: { failed_login_attempts: 0, locked_until: null } });
  auditLog('login_success', { userId: user._id, ip: req.ip });

  setAuthCookies(res, user);
  return res.json({ user: toPublicUser(user) });
}

/** POST /api/auth/logout */
function logout(req, res) {
  clearAuthCookies(res);
  return res.status(204).send();
}

/** GET /api/auth/me */
async function me(req, res) {
  const user = await db.users.findOneAsync({ _id: req.user.id });
  const publicUser = toPublicUser(user);
  publicUser.cpfMascarado = `***.***.***-${user.cpf_last2}`;
  return res.json({ user: publicUser });
}

/** POST /api/auth/forgot-password */
async function forgotPassword(req, res) {
  const { email } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.users.findOneAsync({ email: String(normalizedEmail) });

  // Resposta sempre genérica e com o mesmo formato, exista ou não o e-mail:
  // evita que a rota seja usada para descobrir quais e-mails estão cadastrados.
  const genericResponse = () =>
    res.json({ message: 'Se este e-mail estiver cadastrado, você receberá instruções de recuperação em instantes.' });

  if (!user) {
    auditLog('password_reset_requested_unknown_email', { ip: req.ip });
    return genericResponse();
  }

  const { token, tokenHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

  await db.passwordResetTokens.insertAsync({
    user_id: user._id,
    token_hash: tokenHash, // só o hash SHA-256 vai para o banco, nunca o token
    expires_at: expiresAt,
    used_at: null,
    created_at: new Date(),
  });

  const resetUrl = `${publicBaseUrl()}/reset-password.html?token=${token}`;
  sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl });
  auditLog('password_reset_requested', { userId: user._id, ip: req.ip });

  return genericResponse();
}

/** POST /api/auth/reset-password */
async function resetPassword(req, res) {
  const { token, newPassword } = req.body;
  const tokenHash = hashToken(token);

  const passwordHash = bcrypt.hashSync(newPassword, 12);
  const invalid = () => {
    const err = new Error('Link de recuperação inválido ou expirado.');
    err.status = 400;
    return err;
  };

  let record;
  try {
    // Checagem e consumo do token dentro da seção crítica: dois envios
    // simultâneos do mesmo link não conseguem usar o token duas vezes.
    record = await withTransaction(async () => {
      const found = await db.passwordResetTokens.findOneAsync({ token_hash: String(tokenHash) });
      if (!found || found.used_at || new Date(found.expires_at) < new Date()) throw invalid();

      const now = new Date();
      await db.users.updateAsync(
        { _id: found.user_id },
        { $set: { password_hash: passwordHash, failed_login_attempts: 0, locked_until: null } }
      );
      // Token de uso único + invalida todos os outros tokens pendentes do usuário.
      await db.passwordResetTokens.updateAsync(
        { user_id: found.user_id, used_at: null },
        { $set: { used_at: now } },
        { multi: true }
      );
      return found;
    });
  } catch (err) {
    if (err.status === 400) {
      auditLog('password_reset_invalid_token', { ip: req.ip });
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  auditLog('password_reset_completed', { userId: record.user_id, ip: req.ip });
  return res.json({ message: 'Senha redefinida com sucesso. Faça login com a nova senha.' });
}

module.exports = { register, login, logout, me, forgotPassword, resetPassword };
