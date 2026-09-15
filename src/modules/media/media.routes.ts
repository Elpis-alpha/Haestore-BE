import { Router } from 'express';
import { body, validateBody } from '../../middleware/validate.js';
import { describeUpload, issueUploadTicket } from '../../media/cloudinary.js';
import { confirmUploadSchema, type ConfirmUploadInput } from './media.schema.js';

/**
 * Photograph uploads from the console, mounted under the admin gate.
 *
 * Two calls around a browser-to-Cloudinary upload: a signed ticket before it, and a
 * confirmation after it that reads the photograph back from Cloudinary and returns what the
 * product form stores. Neither changes anything in the shop — the product save that follows
 * does — so neither needs step-up, and both are audited by being mounted here.
 */
export const adminMediaRouter: Router = Router();

adminMediaRouter.post('/uploads', (_req, res) => {
  res.status(201).json({ data: issueUploadTicket() });
});

adminMediaRouter.post('/uploads/confirm', validateBody(confirmUploadSchema), async (req, res) => {
  const { publicId } = body<ConfirmUploadInput>(req);
  res.json({ data: await describeUpload(publicId) });
});
