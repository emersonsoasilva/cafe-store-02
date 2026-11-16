const express = require('express');
const { body } = require('express-validator');
const validateRequest = require('../middleware/validateRequest');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const automation = require('../services/automation');

const router = express.Router();

// Automação de operações (painel "Administração"): executa funcionalidades
// reais da loja em produção. Login obrigatório + papel "admin" (RBAC): um
// cliente comum recebe 403 mesmo chamando a API direto, sem a tela.
router.use('/admin/automation', requireAuth, requireRole('admin'));

router.get(
  '/admin/automation',
  asyncHandler(async (req, res) => res.json(await automation.status()))
);

router.post(
  '/admin/automation/start',
  requireCsrf,
  [
    body('phaseSeconds').optional({ values: 'falsy' }).isInt({ min: 5, max: 3600 })
      .withMessage('A duração da fase deve ser entre 5 e 3600 segundos.').toInt(),
    body('intervalSeconds').optional({ values: 'falsy' }).isInt({ min: 1, max: 60 })
      .withMessage('O intervalo entre ações deve ser entre 1 e 60 segundos.').toInt(),
    body('intervalSeconds').custom((value, { req }) => {
      if (value && req.body.phaseSeconds && Number(value) > Number(req.body.phaseSeconds)) {
        throw new Error('O intervalo entre ações não pode ser maior que a duração da fase.');
      }
      return true;
    }),
  ],
  validateRequest,
  asyncHandler(async (req, res) => {
    const { phaseSeconds, intervalSeconds } = req.body;
    const { alreadyRunning } = automation.start(req.user, { phaseSeconds, intervalSeconds });
    if (alreadyRunning) return res.status(409).json({ error: 'A automação já está ativa.' });
    return res.json(await automation.status());
  })
);

router.post(
  '/admin/automation/stop',
  requireCsrf,
  asyncHandler(async (req, res) => {
    const { alreadyStopped } = automation.stop(req.user);
    if (alreadyStopped) return res.status(409).json({ error: 'A automação já está desativada.' });
    return res.json(await automation.status());
  })
);

module.exports = router;
