import { Router } from 'express';
import { isAuthenticated } from '../middleware/isAuthenticated.js';
import { toPublicUser } from '../db/types.js';

export const meRouter = Router();

meRouter.get('/me', isAuthenticated, (req, res) => {
  // isAuthenticated guarantees currentUser; the 401 path never reaches here.
  res.json({ user: toPublicUser(req.currentUser!) });
});
