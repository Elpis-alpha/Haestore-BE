import type { z } from 'zod';
import type { createAttributeDefinitionSchema } from '../../modules/catalog/attribute-definition.schema.js';
import type { PhotoSpec } from '../photos.js';

/**
 * The shapes the catalogue data is written in.
 *
 * Deliberately the *input* shapes of the API's own schemas, before defaults: every record
 * here is parsed by the schema the admin console's request is parsed by, and written by the
 * service that request reaches. The seed has no write path of its own.
 */

export type SeedDefinition = z.input<typeof createAttributeDefinitionSchema>;

export type SeedBinding = { key: string; required?: boolean; group?: string };

export type SeedShelf = {
  name: string;
  slug: string;
  description: string;
  bindings?: SeedBinding[];
  /** Keys inherited from above that this shelf does not want. */
  suppress?: string[];
  children?: SeedShelf[];
};

export type SeedVariant = {
  /** Axis key to option value, for every axis the product declares. */
  axis?: Record<string, string>;
  /** Minor units. */
  price: number;
  compareAt?: number;
  onHand: number;
  weightGrams?: number;
};

export type SeedProduct = {
  title: string;
  subtitle: string;
  description: string;
  /** The shelf's path, e.g. `coffee-tea/coffee`. */
  shelf: string;
  attributes: Record<string, unknown>;
  /** The axes are the keys of the variants' `axis`, in the order they appear. */
  variants: SeedVariant[];
  photos: PhotoSpec[];
  /** How often it is bought, relative to everything else. Drives the seeded orders. */
  demand: number;
  /** The star rating its reviewers tend towards. */
  regard: number;
  status?: 'active' | 'draft';
};
