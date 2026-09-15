import { z } from 'zod';

/** The browser names what it uploaded, and nothing else; everything stored is read back. */
export const confirmUploadSchema = z.strictObject({
  publicId: z.string().trim().min(1).max(255),
});

export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;
